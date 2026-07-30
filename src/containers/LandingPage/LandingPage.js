import React from 'react';
import loadable from '@loadable/component';

import { bool, object } from 'prop-types';
import { compose } from 'redux';
import { connect } from 'react-redux';

import { camelize } from '../../util/string';
import { propTypes } from '../../util/types';

import FallbackPage from './FallbackPage';
import SectionOccasions from './SectionOccasions';
import { ASSET_NAME } from './LandingPage.duck';
import { fetchFeaturedListings } from '../../ducks/featuredListings.duck';
import { getListingsById } from '../../ducks/marketplaceData.duck';
import { getFeaturedListingsProps } from '../../util/data';

const PageBuilder = loadable(() =>
  import(/* webpackChunkName: "PageBuilder" */ '../PageBuilder/PageBuilder')
);

// Custom "Shop by occasion" section that is injected among the Console-hosted
// sections. The sectionType is mapped to the SectionOccasions component through
// PageBuilder's options.sectionComponents.
const occasionsSection = {
  sectionType: 'occasions',
  sectionId: 'shop-by-occasion',
};

// Inject the custom occasions section right after the first Console-hosted
// section (typically the hero). If the hosted asset has no sections yet, the
// occasions section is rendered on its own. This keeps working even when
// operators add, remove, or reorder sections in Console.
const withOccasionsSection = pageData => {
  if (!pageData) {
    return pageData;
  }
  const hostedSections = pageData.sections || [];
  const insertIndex = hostedSections.length > 0 ? 1 : 0;
  const sections = [
    ...hostedSections.slice(0, insertIndex),
    occasionsSection,
    ...hostedSections.slice(insertIndex),
  ];
  return { ...pageData, sections };
};

export const LandingPageComponent = props => {
  const { pageAssetsData, inProgress, error } = props;

  return (
    <PageBuilder
      pageAssetsData={withOccasionsSection(pageAssetsData?.[camelize(ASSET_NAME)]?.data)}
      options={{
        sectionComponents: {
          occasions: { component: SectionOccasions },
        },
      }}
      inProgress={inProgress}
      error={error}
      fallbackPage={<FallbackPage error={error} />}
      featuredListings={getFeaturedListingsProps(camelize(ASSET_NAME), props)}
    />
  );
};

LandingPageComponent.propTypes = {
  pageAssetsData: object,
  inProgress: bool,
  error: propTypes.error,
};

const mapStateToProps = state => {
  const { pageAssetsData, inProgress, error } = state.hostedAssets || {};
  const featuredListingData = state.featuredListings || {};

  const getListingEntitiesById = listingIds => getListingsById(state, listingIds);

  return { pageAssetsData, featuredListingData, getListingEntitiesById, inProgress, error };
};

const mapDispatchToProps = dispatch => ({
  onFetchFeaturedListings: (sectionId, parentPage, listingImageConfig, allSections) =>
    dispatch(fetchFeaturedListings({ sectionId, parentPage, listingImageConfig, allSections })),
});

// Note: it is important that the withRouter HOC is **outside** the
// connect HOC, otherwise React Router won't rerender any Route
// components since connect implements a shouldComponentUpdate
// lifecycle hook.
//
// See: https://github.com/ReactTraining/react-router/issues/4671
const LandingPage = compose(
  connect(
    mapStateToProps,
    mapDispatchToProps
  )
)(LandingPageComponent);

export default LandingPage;
