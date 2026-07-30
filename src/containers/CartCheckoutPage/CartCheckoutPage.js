import React, { useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';

import { useConfiguration } from '../../context/configurationContext';
import { useIntl } from '../../util/reactIntl';
import { isScrollingDisabled } from '../../ducks/ui.duck';
import { selectCartByProvider, selectCartItemCount } from '../../ducks/cart.duck';
import { hasDefaultPaymentMethod } from '../CheckoutPage/CheckoutPageTransactionHelpers';

import { H3, H4, LayoutSingleColumn, NamedLink, Page, PrimaryButton } from '../../components';

import TopbarContainer from '../TopbarContainer/TopbarContainer';
import FooterContainer from '../FooterContainer/FooterContainer';

import {
  fetchStripeCustomer,
  processCartCheckout,
  resetCheckout,
  ITEM_STATUS,
} from './CartCheckoutPage.duck';

import css from './CartCheckoutPage.module.css';

/**
 * CartCheckoutPage orchestrates multiple Sharetribe transactions,
 * one per cart item (Sharetribe transactions are single-listing).
 *
 * The flow requires a saved default card: the card is attached to the
 * customer's Stripe customer, which makes it reusable across the
 * multiple PaymentIntents created in the sequence. Shipping details are
 * collected once and attached to every order.
 */

const INITIAL_SHIPPING = {
  name: '',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postal: '',
  country: 'US',
};

const StatusBadge = ({ status }) => {
  if (!status) return null;
  const labels = {
    [ITEM_STATUS.PROCESSING]: 'Processing…',
    [ITEM_STATUS.SUCCESS]: 'Order placed',
    [ITEM_STATUS.FAILED]: 'Failed',
  };
  const classes = {
    [ITEM_STATUS.PROCESSING]: css.statusProcessing,
    [ITEM_STATUS.SUCCESS]: css.statusSuccess,
    [ITEM_STATUS.FAILED]: css.statusFailed,
  };
  return labels[status.status] ? (
    <span className={classes[status.status]}>{labels[status.status]}</span>
  ) : null;
};

const CartCheckoutPage = () => {
  const config = useConfiguration();
  const intl = useIntl();
  const dispatch = useDispatch();

  const cartByProvider = useSelector(selectCartByProvider);
  const itemCount = useSelector(selectCartItemCount);
  const scrollingDisabled = useSelector(state => isScrollingDisabled(state));
  const currentUser = useSelector(state => state.user.currentUser);
  const {
    itemStatuses,
    checkoutInProgress,
    checkoutError,
    completedOrderIds,
    checkoutComplete,
    stripeCustomerFetched,
  } = useSelector(state => state.CartCheckoutPage);

  const [stripe, setStripe] = useState(null);
  const [shipping, setShipping] = useState(INITIAL_SHIPPING);

  useEffect(() => {
    dispatch(resetCheckout());
    dispatch(fetchStripeCustomer());
  }, [dispatch]);

  // Stripe.js is included globally (util/includeScripts), same as CheckoutPage.
  useEffect(() => {
    if (!stripe && typeof window !== 'undefined' && window.Stripe && config.stripe.publishableKey) {
      setStripe(window.Stripe(config.stripe.publishableKey));
    }
  }, [config.stripe.publishableKey]);

  const title = 'Checkout';

  const hasSavedCard = hasDefaultPaymentMethod(stripeCustomerFetched, currentUser);
  const defaultCard = currentUser?.stripeCustomer?.defaultPaymentMethod?.attributes?.card;
  const paymentMethodId =
    currentUser?.stripeCustomer?.defaultPaymentMethod?.attributes?.stripePaymentMethodId;

  const setField = field => e => setShipping({ ...shipping, [field]: e.target.value });
  const shippingValid = shipping.name && shipping.line1 && shipping.city && shipping.postal;

  const handlePlaceOrders = () => {
    if (checkoutInProgress) return;
    const items = cartByProvider.flatMap(group => group.items);
    const shippingDetails = {
      shippingDetails: {
        name: shipping.name,
        phoneNumber: shipping.phone,
        address: {
          line1: shipping.line1,
          line2: shipping.line2,
          city: shipping.city,
          state: shipping.state,
          postalCode: shipping.postal,
          country: shipping.country,
        },
      },
    };
    dispatch(processCartCheckout({ items, shippingDetails, stripe, paymentMethodId })).catch(
      () => {
        // Error state is handled in the duck; failed and remaining items stay in the cart.
      }
    );
  };

  const pageWrap = content => (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <LayoutSingleColumn topbar={<TopbarContainer />} footer={<FooterContainer />}>
        <div className={css.content}>{content}</div>
      </LayoutSingleColumn>
    </Page>
  );

  if (checkoutComplete) {
    return pageWrap(
      <div className={css.successMessage}>
        <H3 as="h1">Orders Placed Successfully!</H3>
        <p>
          {completedOrderIds.length} order{completedOrderIds.length !== 1 ? 's' : ''} placed.
        </p>
        <p className={css.note}>
          Each lender will ship their items separately. You'll receive confirmation emails for each
          order.
        </p>
        <NamedLink name="InboxPage" params={{ tab: 'orders' }} className={css.viewOrdersButton}>
          View My Orders
        </NamedLink>
      </div>
    );
  }

  if (itemCount === 0) {
    return pageWrap(
      <div className={css.emptyCart}>
        <p>Your cart is empty.</p>
        <NamedLink name="SearchPage" className={css.browseLink}>
          Browse listings
        </NamedLink>
      </div>
    );
  }

  if (!currentUser) {
    return pageWrap(
      <div className={css.emptyCart}>
        <p>Please log in to check out.</p>
        <NamedLink name="LoginPage" className={css.browseLink}>
          Log in
        </NamedLink>
      </div>
    );
  }

  const processedCount = Object.values(itemStatuses).filter(
    s => s.status === ITEM_STATUS.SUCCESS
  ).length;
  const totalItems = cartByProvider.reduce((sum, g) => sum + g.items.length, 0);

  return pageWrap(
    <>
      <H3 as="h1" className={css.heading}>
        Checkout
      </H3>

      <p className={css.description}>
        Your order will be split into {cartByProvider.length} separate transaction
        {cartByProvider.length !== 1 ? 's' : ''}, one per lender. Payment is preauthorized and only
        captured when each lender accepts your order.
      </p>

      {checkoutInProgress && (
        <div className={css.processingBanner}>
          Placing orders… {processedCount} of {totalItems} complete. Don't close this page.
        </div>
      )}

      {checkoutError && (
        <div className={css.errorBanner}>
          Something went wrong while placing your orders
          {completedOrderIds.length > 0
            ? `: ${completedOrderIds.length} order(s) were placed successfully before the failure — the remaining items are still in your cart.`
            : '. No payment was captured — any pending authorization on your card is released automatically. Please check your payment method and try again.'}
        </div>
      )}

      {cartByProvider.map((group, index) => (
        <div key={group.providerId} className={css.providerGroup}>
          <div className={css.providerHeader}>
            <span className={css.providerName}>
              Order {index + 1}: {group.providerName || 'Lender'}
            </span>
            <span className={css.itemCount}>
              {group.items.length} item{group.items.length !== 1 ? 's' : ''}
            </span>
          </div>

          {group.items.map(item => (
            <div key={item.listingId} className={css.cartItem}>
              <span className={css.itemTitle}>{item.title}</span>
              <span className={css.itemMeta}>
                <StatusBadge status={itemStatuses[item.listingId]} />
                <span className={css.itemPrice}>
                  {item.price ? `$${(item.price.amount / 100).toFixed(2)}` : ''}
                  {item.quantity > 1 ? ` x${item.quantity}` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      ))}

      <div className={css.checkoutActions}>
        <H4 as="h2" className={css.sectionHeading}>
          Shipping address
        </H4>
        <div className={css.shippingForm}>
          <label className={css.formField}>
            <span className={css.formLabel}>Full name *</span>
            <input type="text" value={shipping.name} onChange={setField('name')} autoComplete="name" />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>Phone number</span>
            <input type="tel" value={shipping.phone} onChange={setField('phone')} autoComplete="tel" />
          </label>
          <label className={css.formFieldWide}>
            <span className={css.formLabel}>Address line 1 *</span>
            <input
              type="text"
              value={shipping.line1}
              onChange={setField('line1')}
              autoComplete="address-line1"
            />
          </label>
          <label className={css.formFieldWide}>
            <span className={css.formLabel}>Address line 2</span>
            <input
              type="text"
              value={shipping.line2}
              onChange={setField('line2')}
              autoComplete="address-line2"
            />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>City *</span>
            <input
              type="text"
              value={shipping.city}
              onChange={setField('city')}
              autoComplete="address-level2"
            />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>State</span>
            <input
              type="text"
              value={shipping.state}
              onChange={setField('state')}
              autoComplete="address-level1"
            />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>ZIP / Postal code *</span>
            <input
              type="text"
              value={shipping.postal}
              onChange={setField('postal')}
              autoComplete="postal-code"
            />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>Country</span>
            <select value={shipping.country} onChange={setField('country')}>
              <option value="US">United States</option>
              <option value="CA">Canada</option>
            </select>
          </label>
        </div>

        <H4 as="h2" className={css.sectionHeading}>
          Payment
        </H4>
        {!stripeCustomerFetched ? (
          <p className={css.shippingNote}>Loading payment details…</p>
        ) : hasSavedCard ? (
          <p className={css.savedCard}>
            Paying with saved card: {defaultCard?.brand?.toUpperCase()} •••• {defaultCard?.last4Digits}
            <NamedLink name="PaymentMethodsPage" className={css.changeCardLink}>
              Change
            </NamedLink>
          </p>
        ) : (
          <div className={css.noCardNotice}>
            <p>
              Multi-lender checkout uses your saved card so all orders can be placed in one go.
              Please add a payment method first, then return to this page.
            </p>
            <NamedLink name="PaymentMethodsPage" className={css.browseLink}>
              Add a payment method
            </NamedLink>
          </div>
        )}

        <p className={css.shippingNote}>
          Card holds may apply depending on lender settings; they are shown in each order's price
          breakdown and released if a lender declines.
        </p>

        <PrimaryButton
          type="button"
          onClick={handlePlaceOrders}
          inProgress={checkoutInProgress}
          disabled={
            !hasSavedCard || !shippingValid || !stripe || checkoutInProgress || itemCount === 0
          }
        >
          Place {totalItems} order{totalItems !== 1 ? 's' : ''}
        </PrimaryButton>
        {!shippingValid ? (
          <p className={css.shippingNote}>Fill in the required shipping fields (*) to continue.</p>
        ) : null}
      </div>
    </>
  );
};

export default CartCheckoutPage;
