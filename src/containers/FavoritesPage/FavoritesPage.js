import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';

import { useConfiguration } from '../../context/configurationContext';
import { useRouteConfiguration } from '../../context/routeConfigurationContext';
import { useIntl } from '../../util/reactIntl';
import { isScrollingDisabled } from '../../ducks/ui.duck';
import { getMarketplaceEntities } from '../../ducks/marketplaceData.duck';
import {
  selectFavoriteIds,
  selectFetchInProgress,
  toggleFavorite,
  loadFavorites,
  fetchFavoriteListings,
} from '../../ducks/favorites.duck';

import {
  H3,
  LayoutSingleColumn,
  ListingCard,
  NamedLink,
  Page,
} from '../../components';

import TopbarContainer from '../TopbarContainer/TopbarContainer';
import FooterContainer from '../FooterContainer/FooterContainer';

import css from './FavoritesPage.module.css';

export const FavoritesPageComponent = () => {
  const config = useConfiguration();
  const routeConfiguration = useRouteConfiguration();
  const intl = useIntl();
  const dispatch = useDispatch();

  const favoriteIds = useSelector(selectFavoriteIds);
  const fetchInProgress = useSelector(selectFetchInProgress);
  const scrollingDisabled = useSelector(state => isScrollingDisabled(state));

  // Get listing entities from marketplace data
  const favoriteListingRefs = useSelector(state => state.favorites.favoriteListingRefs);
  const favoriteListings = useSelector(state => {
    const refs = state.favorites.favoriteListingRefs || [];
    if (refs.length === 0) return [];
    return getMarketplaceEntities(state, refs.map(ref => ({ type: 'listing', id: ref })));
  });

  useEffect(() => {
    dispatch(loadFavorites());
    dispatch(fetchFavoriteListings());
  }, [dispatch]);

  const handleToggleFavorite = listingId => {
    dispatch(toggleFavorite(listingId));
  };

  const title = intl.formatMessage({ id: 'FavoritesPage.title', defaultMessage: 'My Favorites' });

  return (
    <Page title={title} scrollingDisabled={scrollingDisabled}>
      <LayoutSingleColumn
        topbar={<TopbarContainer />}
        footer={<FooterContainer />}
      >
        <div className={css.content}>
          <H3 as="h1" className={css.heading}>
            {title}
          </H3>

          {fetchInProgress ? (
            <div className={css.loading}>Loading favorites...</div>
          ) : favoriteListings.length === 0 ? (
            <div className={css.noResults}>
              <p>You haven't favorited any items yet.</p>
              <NamedLink name="SearchPage" className={css.browseLink}>
                Browse listings
              </NamedLink>
            </div>
          ) : (
            <div className={css.listingCards}>
              {favoriteListings.map(listing => (
                <ListingCard
                  key={listing.id.uuid}
                  listing={listing}
                  className={css.listingCard}
                />
              ))}
            </div>
          )}
        </div>
      </LayoutSingleColumn>
    </Page>
  );
};

export { loadData } from './FavoritesPage.duck';

export default FavoritesPageComponent;
