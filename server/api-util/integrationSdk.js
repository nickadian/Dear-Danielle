/**
 * Helpers for using the Sharetribe Integration API.
 *
 * The Integration API is needed for operations that the Marketplace API
 * can't do on behalf of a regular user, e.g. reading or updating a
 * listing that is owned by *another* user (listing collaborators).
 *
 * Configuration (Sharetribe Console > Build > Applications > Add new
 * "Integration API" application):
 *   SHARETRIBE_INTEGRATION_SDK_CLIENT_ID
 *   SHARETRIBE_INTEGRATION_SDK_CLIENT_SECRET
 */
const sharetribeSdk = require('sharetribe-flex-sdk');
const flexIntegrationSdk = require('sharetribe-flex-integration-sdk');

const INTEGRATION_CLIENT_ID = process.env.SHARETRIBE_INTEGRATION_SDK_CLIENT_ID;
const INTEGRATION_CLIENT_SECRET = process.env.SHARETRIBE_INTEGRATION_SDK_CLIENT_SECRET;
const INTEGRATION_BASE_URL = process.env.SHARETRIBE_INTEGRATION_SDK_BASE_URL;

const isIntegrationSdkConfigured = () => !!(INTEGRATION_CLIENT_ID && INTEGRATION_CLIENT_SECRET);

// Error with the same shape that api-util/sdk's handleError understands.
const integrationNotConfiguredError = () => {
  const message =
    'Integration API is not configured. Set SHARETRIBE_INTEGRATION_SDK_CLIENT_ID and SHARETRIBE_INTEGRATION_SDK_CLIENT_SECRET environment variables.';
  const error = new Error(message);
  error.status = 501;
  error.statusText = message;
  error.data = {};
  return error;
};

let cachedIntegrationSdk = null;
const getIntegrationSdk = () => {
  if (!isIntegrationSdkConfigured()) {
    throw integrationNotConfiguredError();
  }
  if (!cachedIntegrationSdk) {
    const baseUrlMaybe = INTEGRATION_BASE_URL ? { baseUrl: INTEGRATION_BASE_URL } : {};
    cachedIntegrationSdk = flexIntegrationSdk.createInstance({
      clientId: INTEGRATION_CLIENT_ID,
      clientSecret: INTEGRATION_CLIENT_SECRET,
      ...baseUrlMaybe,
    });
  }
  return cachedIntegrationSdk;
};

// Deep-convert SDK type instances between the two SDK packages.
// Both packages tag their type instances with an _sdkType property, but the
// transit serializers only recognize instances of their own classes.
const typeConverter = targetTypes => {
  const convert = value => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Date) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    switch (value._sdkType) {
      case 'UUID':
        return new targetTypes.UUID(value.uuid);
      case 'Money':
        return new targetTypes.Money(value.amount, value.currency);
      case 'LatLng':
        return new targetTypes.LatLng(value.lat, value.lng);
      case 'LatLngBounds':
        return new targetTypes.LatLngBounds(convert(value.ne), convert(value.sw));
      case 'BigDecimal':
        return new targetTypes.BigDecimal(value.value);
      default:
        return Object.keys(value).reduce((acc, key) => {
          acc[key] = convert(value[key]);
          return acc;
        }, {});
    }
  };
  return convert;
};

// Convert Integration SDK typed values to Marketplace SDK types
// (e.g. before serializing a response with api-util/sdk's serialize).
const toMarketplaceTypes = typeConverter(sharetribeSdk.types);

// Convert Marketplace SDK typed values (deserialized from a transit request
// body) to Integration SDK types before calling the Integration API.
const toIntegrationTypes = typeConverter(flexIntegrationSdk.types);

module.exports = {
  isIntegrationSdkConfigured,
  integrationNotConfiguredError,
  getIntegrationSdk,
  toMarketplaceTypes,
  toIntegrationTypes,
  integrationTypes: flexIntegrationSdk.types,
};
