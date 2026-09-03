'use strict';

/**
 * What a subtitle filename says about the track it holds.
 */

const word = (w) => new RegExp(`(?:^|[^a-z0-9])(?:${w})(?:[^a-z0-9]|$)`, 'i');

const COMMENTARY = word('commentary');
const FORCED = word('forced');
const NON_HI = word('non[-_. ]?hi');
const HI = word('hi|sdh');

/** 'commentary', 'forced', 'plain', 'hi', or null when the name says nothing. */
function trackTypeOf(name) {
    const text = String(name || '');
    if (!text) return null;
    if (COMMENTARY.test(text)) return 'commentary';
    if (FORCED.test(text)) return 'forced';
    if (NON_HI.test(text)) return 'plain';
    if (HI.test(text)) return 'hi';
    return null;
}

/**
 * What an entry claims to be, from its own name and the provider's flag. This is the promise
 * the label makes to the user, so it is also what the archive extraction has to honour.
 */
function declaredTrack(name, hearingImpaired) {
    const fromName = trackTypeOf(name);
    if (fromName === 'commentary' || fromName === 'forced') return fromName;
    if (hearingImpaired || fromName === 'hi') return 'hi';
    return 'plain';
}

module.exports = { trackTypeOf, declaredTrack };
