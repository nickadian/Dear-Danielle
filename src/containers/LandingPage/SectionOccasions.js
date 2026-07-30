import React from 'react';
import classNames from 'classnames';

import { useConfiguration } from '../../context/configurationContext';
import { stringify } from '../../util/urlHelpers';
import { NamedLink } from '../../components';

import css from './SectionOccasions.module.css';

// The public data key of the occasion listing field (multi-enum, searchMode: 'has_any').
const OCCASION_FIELD_KEY = 'occasion';

// Fallback options matching the marketplace's occasion listing field configuration.
// Used only if the hosted/local listing field config doesn't contain the occasion field.
const FALLBACK_OCCASION_OPTIONS = [
  { option: 'wedding', label: 'Wedding' },
  { option: 'date-night', label: 'Date Night' },
  { option: 'work', label: 'Work' },
  { option: 'casual', label: 'Casual' },
  { option: 'formal', label: 'Formal' },
  { option: 'cocktail', label: 'Cocktail' },
  { option: 'vacation', label: 'Vacation' },
  { option: 'brunch', label: 'Brunch' },
  { option: 'festival', label: 'Festival' },
  { option: 'party', label: 'Party' },
];

/**
 * "Shop by occasion" section for the landing page.
 *
 * Renders a horizontal row of occasion tag pills, each linking to the
 * SearchPage with the pub_occasion query param set (has_any semantics).
 * Occasion options are read from the marketplace configuration
 * (listing field 'occasion'), with a hardcoded fallback list.
 *
 * This component is injected into PageBuilder as a custom section type
 * ('occasions') from LandingPage.js, so it works alongside Console-hosted
 * page sections.
 *
 * @param {Object} props
 * @param {string?} props.sectionId id of the section
 * @param {string?} props.className add more style rules in addition to component's own css.root
 * @param {string?} props.rootClassName overwrite component's own css.root
 * @returns {JSX.Element} section with occasion tag links
 */
const SectionOccasions = props => {
  const { sectionId, className, rootClassName } = props;
  const config = useConfiguration();

  const occasionField = config?.listing?.listingFields?.find(f => f.key === OCCASION_FIELD_KEY);
  const enumOptions = occasionField?.enumOptions;
  const options = enumOptions?.length > 0 ? enumOptions : FALLBACK_OCCASION_OPTIONS;

  const classes = classNames(rootClassName || css.root, className);

  return (
    <section id={sectionId} className={classes}>
      <div className={css.content}>
        <h2 className={css.heading}>Shop by occasion</h2>
        <div className={css.tagList}>
          {options.map(o => (
            <NamedLink
              key={o.option}
              name="SearchPage"
              to={{ search: stringify({ pub_occasion: `has_any:${o.option}` }) }}
              className={css.tag}
            >
              {o.label}
            </NamedLink>
          ))}
        </div>
      </div>
    </section>
  );
};

export default SectionOccasions;
