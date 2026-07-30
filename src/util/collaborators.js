/**
 * Helpers for the listing collaborators feature (multi-user listing
 * management). A listing owner can share a listing with other users by
 * email; collaborators can then edit a restricted set of listing fields.
 *
 * Server-side counterpart: server/api/listing-collaborators.js
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Validate a collaborator email address.
 *
 * @param {string} email
 * @returns {boolean}
 */
export const isValidCollaboratorEmail = email => typeof email === 'string' && EMAIL_RE.test(email);

/**
 * Wizard tabs that a collaborator (non-owner) is allowed to see and save.
 * These map to the listing fields that the collaborator update endpoint
 * accepts: title, description, publicData, price, geolocation and stock.
 * Photos, availability, style and the collaborators tab itself stay
 * owner-only.
 *
 * Note: values must match the tab constants in
 * src/containers/EditListingPage/EditListingWizard/EditListingWizardTab.js
 */
export const COLLABORATOR_EDITABLE_TABS = [
  'details',
  'pricing',
  'pricing-and-stock',
  'delivery',
  'location',
];

/**
 * Filter a list of wizard tabs down to the ones a collaborator may use.
 *
 * @param {Array<string>} tabs
 * @returns {Array<string>}
 */
export const pickCollaboratorEditableTabs = tabs =>
  tabs.filter(tab => COLLABORATOR_EDITABLE_TABS.includes(tab));
