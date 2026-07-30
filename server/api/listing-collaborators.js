const { getSdk, getTrustedSdk, handleError, serialize } = require('../api-util/sdk');
const {
  isIntegrationSdkConfigured,
  getIntegrationSdk,
  toMarketplaceTypes,
  toIntegrationTypes,
} = require('../api-util/integrationSdk');

// Collaborators are stored in the listing's privateData as:
//   privateData.collaborators = [{ email, addedAt }]
// A reverse index is kept in each collaborator's own user profile:
//   profile.privateData.sharedListingIds = ['<listing uuid>', ...]
// The listing's collaborators array is always the source of truth for
// authorization; the reverse index is only used to find candidate listings.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const isValidEmail = email => typeof email === 'string' && EMAIL_RE.test(email);
const normalizeEmail = email => email.trim().toLowerCase();

// Fields that a collaborator is allowed to update on a listing.
// Owner-only operations (images, privateData incl. the collaborator list
// itself, metadata, state changes, deletion) are intentionally excluded.
const COLLABORATOR_UPDATABLE_FIELDS = [
  'title',
  'description',
  'price',
  'geolocation',
  'publicData',
];

// Backwards compatibility: older entries were stored as plain strings.
// Normalize every entry to { email, addedAt } and drop unrecognized ones.
const normalizeCollaborators = collaborators => {
  const entries = Array.isArray(collaborators) ? collaborators : [];
  return entries
    .map(entry => {
      if (typeof entry === 'string' && isValidEmail(entry)) {
        return { email: normalizeEmail(entry), addedAt: null };
      }
      if (entry && typeof entry.email === 'string' && isValidEmail(entry.email)) {
        return { email: normalizeEmail(entry.email), addedAt: entry.addedAt || null };
      }
      return null;
    })
    .filter(Boolean);
};

const uuidString = id => (id && id.uuid ? id.uuid : id);

// Whitelist SDK query params that the client may pass through to the
// Integration API (sparse fields, image variants and includes only).
const ALLOWED_INCLUDES = ['author', 'images', 'currentStock'];
const sanitizeQueryParams = (queryParams = {}) => {
  return Object.keys(queryParams).reduce((acc, key) => {
    if (key === 'include') {
      const include = Array.isArray(queryParams.include) ? queryParams.include : [];
      acc.include = include.filter(rel => ALLOWED_INCLUDES.includes(rel));
    } else if (
      key.startsWith('fields.') ||
      key.startsWith('imageVariant.') ||
      key.startsWith('limit.')
    ) {
      acc[key] = queryParams[key];
    }
    return acc;
  }, {});
};

// Derive the caller's email address from their own authenticated session.
// Client-supplied emails are never used for authorization.
const getCallerEmail = async (req, res) => {
  const sdk = getSdk(req, res);
  const response = await sdk.currentUser.show();
  return normalizeEmail(response.data.data.attributes.email);
};

/**
 * Check whether the given email belongs to a collaborator of the listing.
 * Reads the listing via the Integration API (privateData of another user's
 * listing is not readable through the Marketplace API).
 *
 * @param {string|Object} listingId listing id (uuid string or UUID)
 * @param {string} email email address to check
 * @returns {Promise<boolean>}
 */
const isCollaborator = async (listingId, email) => {
  const integrationSdk = getIntegrationSdk();
  const response = await integrationSdk.listings.show({ id: uuidString(listingId) });
  const collaborators = normalizeCollaborators(
    response.data.data.attributes.privateData?.collaborators
  );
  return collaborators.some(c => c.email === normalizeEmail(email));
};

// Convert an Integration API listing response into a Marketplace-SDK-shaped
// transit payload that the client app can merge into its entity store:
// - type is rewritten to 'ownListing' (the edit wizard reads that type)
// - privateData is stripped (it may contain owner-only information)
// - Integration SDK type instances are converted to Marketplace SDK types
const sendListingResponse = (res, apiResponse) => {
  const { status, statusText, data } = apiResponse;
  const doc = toMarketplaceTypes(data);
  if (doc.data) {
    doc.data.type = 'ownListing';
    if (doc.data.attributes) {
      delete doc.data.attributes.privateData;
    }
  }
  res
    .status(status)
    .set('Content-Type', 'application/transit+json')
    .send(serialize({ status, statusText, data: doc }))
    .end();
};

// Reverse index maintenance in the collaborator's user profile.
const updateSharedIndex = async (integrationSdk, user, listingId, shouldContain) => {
  const listingUuid = uuidString(listingId);
  const currentIds = user.attributes.profile.privateData?.sharedListingIds || [];
  const contains = currentIds.includes(listingUuid);
  if (shouldContain === contains) {
    return;
  }
  const sharedListingIds = shouldContain
    ? [...currentIds, listingUuid]
    : currentIds.filter(id => id !== listingUuid);
  await integrationSdk.users.updateProfile({ id: user.id, privateData: { sharedListingIds } });
};

// Verify via trusted SDK that the requester owns the listing. Throws a
// 403-shaped error otherwise. Returns { trustedSdk, ownListing, ownerEmail }.
const requireListingOwner = async (req, listingId) => {
  const trustedSdk = await getTrustedSdk(req);
  const [ownListingResponse, userResponse] = await Promise.all([
    // ownListings.show fails with 404 unless the authenticated user owns the listing.
    trustedSdk.ownListings.show({ id: listingId }),
    trustedSdk.currentUser.show(),
  ]);
  const ownListing = ownListingResponse.data.data;
  const currentUser = userResponse.data.data;
  const authorId = ownListing.relationships?.author?.data?.id?.uuid;
  if (authorId && authorId !== currentUser.id.uuid) {
    const error = new Error('Only the listing owner can manage collaborators.');
    error.status = 403;
    error.statusText = 'Only the listing owner can manage collaborators.';
    error.data = {};
    throw error;
  }
  return { trustedSdk, ownListing, ownerEmail: normalizeEmail(currentUser.attributes.email) };
};

/**
 * GET handler - Get collaborators for a listing. Owner only.
 */
const getCollaborators = async (req, res) => {
  const { listingId } = req.params;
  if (!listingId) {
    return res.status(400).json({ error: 'Missing listingId parameter.' });
  }

  try {
    const { ownListing } = await requireListingOwner(req, listingId);
    const collaborators = normalizeCollaborators(ownListing.attributes.privateData?.collaborators);
    return res.status(200).json({ data: collaborators });
  } catch (e) {
    return handleError(res, e);
  }
};

/**
 * POST handler - Add a collaborator to a listing. Owner only.
 * Accepts { listingId, email } in body. Stores { email, addedAt } in the
 * listing's privateData and maintains the collaborator user's reverse index.
 */
const addCollaborator = async (req, res) => {
  const { listingId, email } = req.body || {};

  if (!listingId || !email) {
    return res.status(400).json({ error: 'Missing listingId or email in request body.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  const normalizedEmail = normalizeEmail(email);

  try {
    const { trustedSdk, ownListing, ownerEmail } = await requireListingOwner(req, listingId);

    if (normalizedEmail === ownerEmail) {
      return res
        .status(400)
        .json({ error: 'The listing owner does not need to be added as a collaborator.' });
    }

    const collaborators = normalizeCollaborators(ownListing.attributes.privateData?.collaborators);
    if (collaborators.some(c => c.email === normalizedEmail)) {
      return res.status(200).json({ data: collaborators });
    }

    // When the Integration API is configured, require that the email belongs
    // to an existing marketplace user and maintain their reverse index.
    let collaboratorUser = null;
    if (isIntegrationSdkConfigured()) {
      const integrationSdk = getIntegrationSdk();
      try {
        const userResponse = await integrationSdk.users.show({ email: normalizedEmail });
        collaboratorUser = userResponse.data.data;
      } catch (e) {
        if (e.status === 404) {
          return res
            .status(404)
            .json({ error: 'No marketplace user was found with that email address.' });
        }
        throw e;
      }
    }

    const updatedCollaborators = [
      ...collaborators,
      { email: normalizedEmail, addedAt: new Date().toISOString() },
    ];

    await trustedSdk.ownListings.update({
      id: listingId,
      privateData: { collaborators: updatedCollaborators },
    });

    if (collaboratorUser) {
      await updateSharedIndex(getIntegrationSdk(), collaboratorUser, listingId, true);
    }

    return res.status(200).json({ data: updatedCollaborators });
  } catch (e) {
    return handleError(res, e);
  }
};

/**
 * DELETE handler - Remove a collaborator from a listing. Owner only.
 * Accepts { listingId, email } in body.
 */
const removeCollaborator = async (req, res) => {
  const { listingId, email } = req.body || {};

  if (!listingId || !email) {
    return res.status(400).json({ error: 'Missing listingId or email in request body.' });
  }
  const normalizedEmail = normalizeEmail(email);

  try {
    const { trustedSdk, ownListing } = await requireListingOwner(req, listingId);

    const collaborators = normalizeCollaborators(ownListing.attributes.privateData?.collaborators);
    const updatedCollaborators = collaborators.filter(c => c.email !== normalizedEmail);

    await trustedSdk.ownListings.update({
      id: listingId,
      privateData: { collaborators: updatedCollaborators },
    });

    // Best effort clean-up of the reverse index.
    if (isIntegrationSdkConfigured()) {
      try {
        const integrationSdk = getIntegrationSdk();
        const userResponse = await integrationSdk.users.show({ email: normalizedEmail });
        await updateSharedIndex(integrationSdk, userResponse.data.data, listingId, false);
      } catch (e) {
        // The user may have been deleted; the listing's collaborator list is
        // the source of truth, so a stale reverse index entry is harmless.
      }
    }

    return res.status(200).json({ data: updatedCollaborators });
  } catch (e) {
    return handleError(res, e);
  }
};

/**
 * GET handler - List listings that are shared with the current user,
 * i.e. listings where the caller's email is in the collaborator list.
 * Returns lightweight JSON: [{ id, title, state, imageUrl }].
 */
const sharedWithMe = async (req, res) => {
  try {
    const sdk = getSdk(req, res);
    const currentUserResponse = await sdk.currentUser.show();
    const currentUser = currentUserResponse.data.data;
    const callerEmail = normalizeEmail(currentUser.attributes.email);
    const sharedListingIds = currentUser.attributes.profile.privateData?.sharedListingIds || [];

    if (!isIntegrationSdkConfigured() || sharedListingIds.length === 0) {
      return res.status(200).json({ data: [] });
    }

    const integrationSdk = getIntegrationSdk();
    const response = await integrationSdk.listings.query({
      ids: sharedListingIds.slice(0, 100),
      include: ['images'],
      'fields.image': ['variants.listing-card', 'variants.listing-card-2x'],
      'limit.images': 1,
    });

    const included = response.data.included || [];
    const imagesById = included.reduce((acc, entity) => {
      if (entity.type === 'image') {
        acc[entity.id.uuid] = entity;
      }
      return acc;
    }, {});

    const listings = response.data.data
      // Authoritative check: the reverse index is just a lookup aid, the
      // listing's own collaborator list decides membership.
      .filter(l =>
        normalizeCollaborators(l.attributes.privateData?.collaborators).some(
          c => c.email === callerEmail
        )
      )
      .map(l => {
        const firstImageRef = l.relationships?.images?.data?.[0];
        const image = firstImageRef ? imagesById[firstImageRef.id.uuid] : null;
        const variants = image?.attributes?.variants || {};
        const firstVariant = Object.values(variants)[0];
        return {
          id: l.id.uuid,
          title: l.attributes.title,
          state: l.attributes.state,
          imageUrl: variants['listing-card']?.url || firstVariant?.url || null,
        };
      });

    return res.status(200).json({ data: listings });
  } catch (e) {
    return handleError(res, e);
  }
};

/**
 * POST handler - Fetch a listing for editing as a collaborator.
 * Accepts transit body { listingId, queryParams }. The caller must be a
 * collaborator of the listing (verified against the caller's own session).
 */
const showSharedListing = async (req, res) => {
  const { listingId, queryParams } = req.body || {};
  if (!listingId) {
    return res.status(400).json({ error: 'Missing listingId in request body.' });
  }

  try {
    const callerEmail = await getCallerEmail(req, res);
    const integrationSdk = getIntegrationSdk();
    const response = await integrationSdk.listings.show({
      id: uuidString(listingId),
      ...sanitizeQueryParams(queryParams),
    });

    const collaborators = normalizeCollaborators(
      response.data.data.attributes.privateData?.collaborators
    );
    if (!collaborators.some(c => c.email === callerEmail)) {
      return res.status(403).json({ error: 'You are not a collaborator of this listing.' });
    }

    return sendListingResponse(res, response);
  } catch (e) {
    return handleError(res, e);
  }
};

/**
 * POST handler - Update a listing as a collaborator.
 * Accepts transit body { listingId, updateValues, stockUpdate, queryParams }.
 * Only whitelisted fields (title, description, price, geolocation,
 * publicData) and stock totals can be updated. The caller's email is derived
 * from their authenticated session and checked against the listing's
 * collaborator list before the privileged Integration API update is made.
 */
const updateSharedListing = async (req, res) => {
  const { listingId, updateValues, stockUpdate, queryParams } = req.body || {};
  if (!listingId) {
    return res.status(400).json({ error: 'Missing listingId in request body.' });
  }

  try {
    const callerEmail = await getCallerEmail(req, res);
    const allowed = await isCollaborator(listingId, callerEmail);
    if (!allowed) {
      return res.status(403).json({ error: 'You are not a collaborator of this listing.' });
    }

    const fields = COLLABORATOR_UPDATABLE_FIELDS.reduce((acc, key) => {
      if (updateValues && typeof updateValues[key] !== 'undefined') {
        acc[key] = toIntegrationTypes(updateValues[key]);
      }
      return acc;
    }, {});

    const hasStockUpdate = stockUpdate && typeof stockUpdate.newTotal === 'number';
    if (Object.keys(fields).length === 0 && !hasStockUpdate) {
      return res.status(400).json({ error: 'No updatable fields in request body.' });
    }

    const integrationSdk = getIntegrationSdk();
    if (hasStockUpdate) {
      const oldTotal = typeof stockUpdate.oldTotal === 'number' ? stockUpdate.oldTotal : null;
      await integrationSdk.stock.compareAndSet({
        listingId: uuidString(listingId),
        oldTotal,
        newTotal: stockUpdate.newTotal,
      });
    }

    const response = await integrationSdk.listings.update(
      { id: uuidString(listingId), ...fields },
      { expand: true, ...sanitizeQueryParams(queryParams) }
    );

    return sendListingResponse(res, response);
  } catch (e) {
    return handleError(res, e);
  }
};

module.exports = {
  getCollaborators,
  addCollaborator,
  removeCollaborator,
  sharedWithMe,
  showSharedListing,
  updateSharedListing,
  isCollaborator,
};
