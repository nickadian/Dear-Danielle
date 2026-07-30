import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

import { initiatePrivileged } from '../../util/api';
import { denormalisedResponseEntities } from '../../util/data';
import { storableError } from '../../util/errors';
import * as log from '../../util/log';
import { types as sdkTypes } from '../../util/sdkLoader';
import { getProcess, resolveLatestProcessName } from '../../transactions/transaction';
import { setCurrentUserHasOrders, fetchCurrentUser } from '../../ducks/user.duck';
import { confirmCardPayment } from '../../ducks/stripe.duck';
import { removeFromCart } from '../../ducks/cart.duck';

const { UUID } = sdkTypes;

// ================ CartCheckoutPage Duck ================ //
// Orchestrates multiple Sharetribe transactions from the cart:
// one transaction per cart item (Sharetribe transactions are
// single-listing). Payment uses the customer's saved default card,
// which is attached to their Stripe customer and therefore reusable
// across the multiple PaymentIntents created in the sequence.
//
// Per item the sequence is the same as the standard CheckoutPage:
//   1. initiate transition/request-payment (privileged, creates PaymentIntent
//      with the saved payment method already set on the API side)
//   2. stripe.confirmCardPayment against the PaymentIntent client secret
//   3. transition/confirm-payment against the Marketplace API
// On success the item is removed from the cart, so a mid-sequence failure
// leaves only unpurchased items in the cart.

// Item checkout statuses
export const ITEM_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  FAILED: 'failed',
};

/////////////////////////////
// Fetch Stripe Customer   //
/////////////////////////////
const fetchStripeCustomerPayloadCreator = (_, { dispatch, rejectWithValue }) => {
  const fetchCurrentUserOptions = {
    callParams: { include: ['stripeCustomer.defaultPaymentMethod'] },
    updateHasListings: false,
    updateNotifications: false,
    enforce: true,
  };

  return dispatch(fetchCurrentUser(fetchCurrentUserOptions)).catch(e => {
    return rejectWithValue(storableError(e));
  });
};

export const fetchStripeCustomerThunk = createAsyncThunk(
  'CartCheckoutPage/fetchStripeCustomer',
  fetchStripeCustomerPayloadCreator
);
export const fetchStripeCustomer = () => dispatch => {
  return dispatch(fetchStripeCustomerThunk()).unwrap();
};

//////////////////////////////////
// Process one cart item        //
//////////////////////////////////
const processSingleItem = async ({ item, shippingDetails, stripe, paymentMethodId, dispatch, sdk }) => {
  const listingId = new UUID(item.listingId);

  // Fetch the listing to get its up-to-date process alias and unit type.
  // This also fails fast if the listing has been closed or deleted.
  const listingResponse = await sdk.listings.show({ id: listingId });
  const listing = listingResponse?.data?.data;
  const publicData = listing?.attributes?.publicData || {};
  const { transactionProcessAlias, unitType } = publicData;

  if (!transactionProcessAlias) {
    throw new Error(`Listing ${item.listingId} has no transaction process`);
  }

  const processName = resolveLatestProcessName(transactionProcessAlias.split('/')[0]);
  const process = getProcess(processName);
  const requestTransition = process.transitions.REQUEST_PAYMENT;

  // Step 1: initiate order (privileged transition creates the PaymentIntent
  // with the saved payment method, since paymentMethod is passed here).
  const bodyParams = {
    processAlias: transactionProcessAlias,
    transition: requestTransition,
    params: {
      listingId,
      stockReservationQuantity: item.quantity,
      paymentMethod: paymentMethodId,
      protectedData: {
        unitType,
        deliveryMethod: 'shipping',
        ...shippingDetails,
      },
    },
  };
  const orderData = { deliveryMethod: 'shipping' };
  const queryParams = { include: ['booking', 'provider'], expand: true };

  const initiateResponse = await initiatePrivileged({
    isSpeculative: false,
    orderData,
    bodyParams,
    queryParams,
  });
  const order = denormalisedResponseEntities(initiateResponse)[0];
  dispatch(setCurrentUserHasOrders());

  const { stripePaymentIntentClientSecret } =
    order?.attributes?.protectedData?.stripePaymentIntents?.default || {};
  if (!stripePaymentIntentClientSecret) {
    throw new Error(
      `Missing StripePaymentIntents key in transaction's protectedData (listing ${item.listingId})`
    );
  }

  // Step 2: confirm the payment with Stripe. The payment method was set
  // on the API side, so no paymentParams are needed.
  await dispatch(
    confirmCardPayment({
      stripe,
      stripePaymentIntentClientSecret,
      orderId: order.id,
    })
  );

  // Step 3: confirm payment against the Marketplace API.
  // The PaymentIntent is confirmed (authorized) at this point, so retry once
  // on a transient failure rather than leaving the authorization unconfirmed.
  // If both attempts fail, the unconfirmed authorization auto-expires and is
  // released by the transaction process (transition/expire-payment).
  const confirmBody = {
    id: order.id,
    transition: process.transitions.CONFIRM_PAYMENT,
    params: {},
  };
  try {
    await sdk.transactions.transition(confirmBody, { expand: true });
  } catch (e) {
    await sdk.transactions.transition(confirmBody, { expand: true });
  }

  return order;
};

//////////////////////////////////
// Process the whole cart       //
//////////////////////////////////
const processCartCheckoutPayloadCreator = async (
  { items, shippingDetails, stripe, paymentMethodId },
  { dispatch, extra: sdk, rejectWithValue }
) => {
  const completedOrderIds = [];

  for (const item of items) {
    dispatch(setItemStatus({ listingId: item.listingId, status: ITEM_STATUS.PROCESSING }));
    try {
      const order = await processSingleItem({
        item,
        shippingDetails,
        stripe,
        paymentMethodId,
        dispatch,
        sdk,
      });
      completedOrderIds.push(order.id.uuid);
      dispatch(
        setItemStatus({
          listingId: item.listingId,
          status: ITEM_STATUS.SUCCESS,
          orderId: order.id.uuid,
        })
      );
      // Successful orders leave the cart immediately, so a later failure
      // doesn't allow buying the same item twice.
      dispatch(removeFromCart({ listingId: item.listingId }));
    } catch (e) {
      const error = e?.error || storableError(e);
      log.error(e, 'cart-checkout-item-failed', { listingId: item.listingId });
      dispatch(
        setItemStatus({ listingId: item.listingId, status: ITEM_STATUS.FAILED, error })
      );
      // Stop the sequence: if payment failed once (e.g. card declined),
      // it would fail for the remaining items too. Unpurchased items
      // remain in the cart.
      return rejectWithValue({ error, completedOrderIds });
    }
  }

  return { completedOrderIds };
};

export const processCartCheckoutThunk = createAsyncThunk(
  'CartCheckoutPage/processCartCheckout',
  processCartCheckoutPayloadCreator
);
export const processCartCheckout = params => dispatch => {
  return dispatch(processCartCheckoutThunk(params)).unwrap();
};

// ================ Slice ================ //

const initialState = {
  itemStatuses: {}, // listingId -> { status, orderId?, error? }
  checkoutInProgress: false,
  checkoutError: null,
  completedOrderIds: [],
  checkoutComplete: false,
  stripeCustomerFetched: false,
};

const cartCheckoutPageSlice = createSlice({
  name: 'CartCheckoutPage',
  initialState,
  reducers: {
    setItemStatus(state, action) {
      const { listingId, status, orderId, error } = action.payload;
      state.itemStatuses[listingId] = { status, orderId, error };
    },
    resetCheckout() {
      return initialState;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(fetchStripeCustomerThunk.pending, state => {
        state.stripeCustomerFetched = false;
      })
      .addCase(fetchStripeCustomerThunk.fulfilled, state => {
        state.stripeCustomerFetched = true;
      })
      .addCase(fetchStripeCustomerThunk.rejected, state => {
        // Keep the page usable; the component shows the add-card prompt.
        state.stripeCustomerFetched = true;
      })
      .addCase(processCartCheckoutThunk.pending, state => {
        state.checkoutInProgress = true;
        state.checkoutError = null;
        state.itemStatuses = {};
        state.completedOrderIds = [];
        state.checkoutComplete = false;
      })
      .addCase(processCartCheckoutThunk.fulfilled, (state, action) => {
        state.checkoutInProgress = false;
        state.completedOrderIds = action.payload.completedOrderIds;
        state.checkoutComplete = true;
      })
      .addCase(processCartCheckoutThunk.rejected, (state, action) => {
        state.checkoutInProgress = false;
        state.checkoutError = action.payload?.error || action.payload;
        state.completedOrderIds = action.payload?.completedOrderIds || [];
      });
  },
});

export const { setItemStatus, resetCheckout } = cartCheckoutPageSlice.actions;

export default cartCheckoutPageSlice.reducer;
