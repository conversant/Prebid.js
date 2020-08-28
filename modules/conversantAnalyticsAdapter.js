import {ajax} from '../src/ajax.js';
import adapter from '../src/AnalyticsAdapter.js';
import CONSTANTS from '../src/constants.json';
import {getGlobal} from '../src/prebidGlobal.js';
import adapterManager from '../src/adapterManager.js';
import * as utils from '../src/utils.js';

const {
  EVENTS: { AUCTION_END, AD_RENDER_FAILED, BID_TIMEOUT, BID_WON }
} = CONSTANTS;
const GVLID = 24;
const ANALYTICS_TYPE = 'endpoint';

// for local testing set domain to 127.0.0.1:8290
const URL = 'https://web.hb.ad.cpe.dotomi.com/cvx/event/prebidanalytics';
const ANALYTICS_CODE = 'conversant';

export const LOG_PREFIX = 'Conversant analytics adapter: ';

// Maximum time to keep an item in the cache before it gets purged
export const MAX_MILLISECONDS_IN_CACHE = 30000;

// How often cache cleanup will run
export const CACHE_CLEANUP_TIME_IN_MILLIS = 30000;

// Should be integer from 0-100, 0 is turned off, 100 is sample every instance
export const DEFAULT_SAMPLE_RATE = 50;

// BID STATUS CODES
export const CNVR_WIN = 10;
export const CNVR_BID = 20;
export const CNVR_NO_BID = 30;
export const CNVR_TIMEOUT = 40;
export const CNVR_RENDER_FAILED = 50;

// Saves passed in options from the bid adapter
let initOptions;

// Simple flag to help handle any tear down needed on disable
let conversantAnalyticsEnabled = false;

// Turns on sampling for an instance of prebid analytics.
export let doSample = true;

/**
 * Used to hold data for RENDER FAILED events so we can send a payload back that will match our original auction data.
 * Contains the following key/value data:
 * <adId> => {
 *     'bidderCode': <bidderCode>,
 *     'adUnitCode': <adUnitCode>,
 *     'auctionId': <auctionId>,
 *     'timeReceived': Date.now()  //For cache cleaning
 * }
 */
export const adIdLookup = {};

/**
 * Time out events happen before AUCTION END so we can save them in a cache and report them at the same time as the
 * AUCTION END event.  Has the following data and key is based off of auctionId, adUnitCode, bidderCode from
 * keyStr = getLookupKey(auctionId, adUnitCode, bidderCode);
 * <keyStr> => {
 *     timeReceived: Date.now() //so cache can be purged in case it doesn't get cleaned out at auctionEnd
 * }
 */
export const timeoutCache = {};

/**
 * Cleanup timer for the adIdLookup and timeoutCache caches. If all works properly then the caches are self-cleaning
 * but in case something goes sideways we poll periodically to cleanup old values to prevent a memory leak
 */
let cacheCleanupInterval;

let conversantAnalytics = Object.assign(
  adapter({URL, ANALYTICS_TYPE}),
  {
    track({eventType, args}) {
      if (doSample) {
        utils.logMessage(LOG_PREFIX + 'track(): ' + eventType, Object.assign({}, args));
        switch (eventType) {
          case AUCTION_END:
            onAuctionEnd(args);
            break;
          case AD_RENDER_FAILED:
            onAdRenderFailed(args);
            break;
          case BID_WON:
            onBidWon(args);
            break;
          case BID_TIMEOUT:
            onBidTimeout(args);
            break;
        } // END switch
      } // END IF(doSample)
    } // END track()
  }
);

// ================================================== EVENT HANDLERS ===================================================
/**
 * We get the list of timeouts before the endAution, cache them temporarily in a global cache and the endAuction event
 * will pick them up.  Uses getLookupKey() to create the key to the entry from auctionId, adUnitCode and bidderCode.
 * Saves a single value of timeReceived so we can do cache purging periodically.
 *
 * Current assumption is that the timeout will always be an array even if it is just one object in the array.
 * @param args  [{
  "bidId": "80882409358b8a8",
    "bidder": "conversant",
    "adUnitCode": "MedRect",
    "auctionId": "afbd6e0b-e45b-46ab-87bf-c0bac0cb8881"
  }, {
    "bidId": "9da4c107a6f24c8",
    "bidder": "conversant",
    "adUnitCode": "Leaderboard",
    "auctionId": "afbd6e0b-e45b-46ab-87bf-c0bac0cb8881"
  }
 ]
 */
function onBidTimeout(args) {
  args.forEach(timedOutBid => {
    const timeoutCacheKey = getLookupKey(timedOutBid.auctionId, timedOutBid.adUnitCode, timedOutBid.bidder);
    timeoutCache[timeoutCacheKey] = {
      timeReceived: Date.now()
    }
  });
}

/**
 * Bid won occurs after auctionEnd so we need to send this separately. We also save an entry in the adIdLookup cache
 * so that if the render fails we can match up important data so we can send a valid RENDER FAILED event back.
 * @param args bidWon args
 */
function onBidWon(args) {
  const bidderCode = args.bidderCode;
  const adUnitCode = args.adUnitCode;
  const auctionId = args.auctionId;
  // Make sure we have all the data we need
  if (!bidderCode || !adUnitCode || !auctionId) {
    utils.logError(LOG_PREFIX + 'onBidWon() did not get all the necessary data to process the event.');
    return;
  }
  const bidWonPayload = createPayload('bid_won', auctionId);

  const adUnitPayload = createAdUnit();
  bidWonPayload.adUnits[adUnitCode] = adUnitPayload;

  const bidPayload = initializeBidDefaults();
  bidPayload.eventCodes.push(CNVR_WIN);
  bidPayload.adSize = createAdSize(args.width, args.height);
  bidPayload.cpm = args.cpm;
  bidPayload.originalCpm = args.originalCpm;
  bidPayload.currency = args.currency;
  bidPayload.timeToRespond = args.timeToRespond;
  adUnitPayload.bids[bidderCode] = bidPayload;

  if (!adIdLookup[args.adId]) {
    adIdLookup[args.adId] = {
      'bidderCode': bidderCode,
      'adUnitCode': adUnitCode,
      'auctionId': auctionId,
      'timeReceived': Date.now() // For cache cleaning
    };
  }

  sendData(bidWonPayload);
}

/**
 * RENDER FAILED occurs after AUCTION END and BID WON, the payload does not have all the data we need so we use
 * adIdLookup to pull data from a BID WON event to populate our payload
 * @param args = {
 *  reason: <value>
 *  message: <value>
 *  adId: <value> --optional
 *  bid: {object?} --optional: unsure what this looks like but guessing it is {bidder: <value>, params: {object}}
 *    }
 */
function onAdRenderFailed(args) {
  const adId = args.adId;
  // Make sure we have all the data we need, adId is optional so it's not guaranteed, without that we can't match it up
  // to our adIdLookup data.
  if (!adId || !adIdLookup[adId]) {
    utils.logError(LOG_PREFIX + "onAdRenderFailed(): Unable to process RENDER FAILED because adId is missing or doesn't match a record in our cache.");
    return; // Either no adId to match against a bidWon event, or no data saved from a bidWon event that matches the adId
  }
  const adIdObj = adIdLookup[adId];
  const adUnitCode = adIdObj['adUnitCode'];
  const bidderCode = adIdObj['bidderCode'];
  const auctionId = adIdObj['auctionId'];
  delete adIdLookup[adId]; // cleanup our cache

  if (!bidderCode || !adUnitCode) {
    utils.logError(LOG_PREFIX + 'onAdRenderFailed(): Unable to process RENDER FAILED because lookup cache did not have all the data we required.');
    return;
  }

  const renderFailedPayload = createPayload('render_failed', auctionId);
  const adUnitPayload = createAdUnit();
  adUnitPayload.bids[bidderCode] = initializeBidDefaults();
  adUnitPayload.bids[bidderCode].eventCodes.push(CNVR_RENDER_FAILED);
  adUnitPayload.bids[bidderCode].message = 'REASON: ' + args.reason + '. MESSAGE: ' + args.message;
  renderFailedPayload.adUnits[adUnitCode] = adUnitPayload;
  sendData(renderFailedPayload);
}

/**
 * AUCTION END contains bid and no bid info and all of the auction info we need. This sends the bulk of the information
 * about the auction back to the servers.  It will also check the timeoutCache for any matching bids, if any are found
 * then they will be removed from the cache and send back with this payload.
 * @param args AUCTION END payload, fairly large data structure, main objects are 'adUnits[]', 'bidderRequests[]',
 * 'noBids[]', 'bidsReceived[]'... 'winningBids[]' seems to be always blank.
 */
function onAuctionEnd(args) {
  const auctionId = args.auctionId;
  if (!auctionId) {
    utils.logError(LOG_PREFIX + 'onAuctionEnd(): No auctionId in args supplied so unable to process event.');
    return;
  }

  const auctionEndPayload = createPayload('auction_end', auctionId);
  // Get bid request information from adUnits
  if (!Array.isArray(args.adUnits)) {
    utils.logError(LOG_PREFIX + 'onAuctionEnd(): adUnits not defined in arguments.');
    return;
  }

  args.adUnits.forEach(adUnit => {
    const cnvrAdUnit = createAdUnit();
    // Initialize bids with bidderCode
    adUnit.bids.forEach(bid => {
      cnvrAdUnit.bids[bid.bidder] = initializeBidDefaults();

      // Check for cached timeout responses
      const timeoutKey = getLookupKey(auctionId, adUnit.code, bid.bidder);
      if (timeoutCache[timeoutKey]) {
        cnvrAdUnit.bids[bid.bidder].eventCodes.push(CNVR_TIMEOUT);
        cnvrAdUnit.bids[bid.bidder].timeToRespond = args.timeout; // set to Auction defined timeout amount
        delete timeoutCache[timeoutKey];
      }
    });

    // Validate adUnit size info before adding it to our payload.
    if (Array.isArray(adUnit.sizes) && adUnit.sizes.length >= 1) {
      const adSizes = adUnit.sizes;
      adSizes.forEach(size => {
        if (!Array.isArray(size) || size.length !== 2) {
          utils.logMessage(LOG_PREFIX + 'Unknown object while retrieving adUnit sizes.', adUnit);
          return; // skips to next item
        }
        cnvrAdUnit.sizes.push({
          w: size[0],
          h: size[1]
        });
      });
    }

    auctionEndPayload.adUnits[adUnit.code] = cnvrAdUnit;
  });

  if (Array.isArray(args.noBids)) {
    args.noBids.forEach(noBid => {
      const bidPayload = utils.deepAccess(auctionEndPayload, 'adUnits.' + noBid.adUnitCode + '.bids.' + noBid.bidder);

      if (bidPayload) {
        bidPayload.eventCodes.push(CNVR_NO_BID);
        bidPayload.timeToRespond = 0; // no info for this, would have to capture event and save it there
      } else {
        utils.logMessage(LOG_PREFIX + 'Unable to locate bid object via adUnitCode/bidderCode in payload for noBid reply in END_AUCTION', Object.assign({}, noBid));
      }
    });
  } else {
    utils.logError(LOG_PREFIX + 'onAuctionEnd(): noBids not defined in arguments.');
  }

  // Get bid data from bids sent
  if (Array.isArray(args.bidsReceived)) {
    args.bidsReceived.forEach(bid => {
      const bidPayload = utils.deepAccess(auctionEndPayload, 'adUnits.' + bid.adUnitCode + '.bids.' + bid.bidderCode);
      if (bidPayload) {
        bidPayload.eventCodes.push(CNVR_BID);
        bidPayload.timeToRespond = bid.timeToRespond;
        bidPayload.originalCpm = bid.originalCpm;
        bidPayload.cpm = bid.cpm;
        bidPayload.currency = bid.currency;
        bidPayload.adSize = {
          'w': bid.width,
          'h': bid.height
        };
      } else {
        utils.logMessage(LOG_PREFIX + 'Unable to locate bid object via adUnitCode/bidderCode in payload for bid reply in END_AUCTION', Object.assign({}, bid));
      }
    });
  } else {
    utils.logError(LOG_PREFIX + 'onAuctionEnd(): bidsReceived not defined in arguments.');
  }

  sendData(auctionEndPayload);
}

// =============================================== START OF HELPERS ===================================================

/**
 * Generic method to look at each key/value pair of a cache object and looks at the 'timeReceived' key, if more than
 * the max wait time has passed then just delete the key.
 * @param cacheObj one of our cache objects [adIdLookup or timeoutCache]
 * @param currTime the current timestamp at the start of the most recent timer execution.
 */
export function cleanCache(cacheObj, currTime) {
  Object.keys(cacheObj).forEach(key => {
    const timeInCache = currTime - cacheObj[key].timeReceived;
    if (timeInCache >= MAX_MILLISECONDS_IN_CACHE) {
      delete cacheObj[key];
    }
  });
}

/**
 * Helper to create an object lookup key for our timeoutCache
 * @param auctionId id of the auction
 * @param adUnitCode ad unit code
 * @param bidderCode bidder code
 * @returns string concatenation of all the params into a string key for timeoutCache
 */
export function getLookupKey(auctionId, adUnitCode, bidderCode) {
  return auctionId + '-' + adUnitCode + '-' + bidderCode;
}

/**
 * Creates our root payload object that gets sent back to the server
 * @param payloadType string type of payload (AUCTION_END, BID_WON, RENDER_FAILED)
 * @param auctionId id for the auction
 * @returns
 *  {{
 *    requestType: *,
 *    adUnits: {},
 *    auction: {
 *      auctionId: *,
 *      preBidVersion: *,
 *      sid: *}
 * }}  Basic structure of our object that we return to the server.
 */
export function createPayload(payloadType, auctionId) {
  return {
    requestType: payloadType,
    auction: {
      auctionId: auctionId,
      preBidVersion: getGlobal().version,
      sid: initOptions.site_id
    },
    adUnits: {}
  };
}

/**
 * Helper to create an adSize object, if the value passed in is not an int then set it to -1
 * @param width in pixels (must be an int)
 * @param height in peixl (must be an int)
 * @returns {{w: *, h: *}} a fully valid adSize object
 */
export function createAdSize(width, height) {
  if (!isInt(width)) {
    width = -1;
  }
  if (!isInt(height)) {
    height = -1;
  }
  return {
    'w': width,
    'h': height
  };
}

/**
 * Helper to create the basic structure of our adUnit payload
 * @returns {{sizes: [], bids: {}}} Basic adUnit payload structure as follows
 */
export function createAdUnit() {
  return {
    sizes: [],
    bids: {}
  };
}

/**
 * Helper to create a basic bid payload object.  By pre-creating the eventCodes we can easily push in our statuses.
*/
export function initializeBidDefaults() {
  return {
    'eventCodes': []
  };
}

/**
 * Helper function to send data back to server.  Need to make sure we don't trigger a CORS preflight by not adding
 * extra header params.
 * @param payload our JSON payload from either AUCTION END, BID WIN, RENDER FAILED
 */
export function sendData(payload) {
  ajax(URL, function () {}, JSON.stringify(payload), {contentType: 'text/plain'});
}

/**
 * Helper to determine if value is integer.  Number.isInteger() not supported everywhere
 * @param value any value
 * @returns {boolean} true if integer, false if not
 */
export function isInt(value) {
  if (isNaN(value)) {
    return false;
  }
  const x = parseFloat(value);
  return (x | 0) === x;
}

// =============================== BOILERPLATE FOR PRE-BID ANALYTICS SETUP  ============================================
// save the base class function
conversantAnalytics.originEnableAnalytics = conversantAnalytics.enableAnalytics;
conversantAnalytics.originDisableAnalytics = conversantAnalytics.disableAnalytics;

// override enableAnalytics so we can get access to the config passed in from the page
conversantAnalytics.enableAnalytics = function (config) {
  if (!config || !config.options || !config.options.site_id) {
    utils.logError(LOG_PREFIX + 'siteId is required.');
    return;
  }

  cacheCleanupInterval = setInterval(
    function() {
      const currTime = Date.now();
      cleanCache(adIdLookup, currTime);
      cleanCache(timeoutCache, currTime);
    },
    CACHE_CLEANUP_TIME_IN_MILLIS
  );

  initOptions = config.options;

  // Use our default sample rate to determine whether to turn on analytics for this instance. If a sample_rate is defined
  // in options and it is an integer <= 100 or >= 0 then use that as the sample rate.
  let sampleRate = DEFAULT_SAMPLE_RATE;
  if (isInt(initOptions.sampleRate) && initOptions.sampleRate >= 0 && initOptions.sampleRate <= 100) {
    sampleRate = initOptions.sampleRate;
  }
  utils.logInfo(LOG_PREFIX + 'Sample rate set to ' + sampleRate + '%');
  // Math.random() pseudo-random number in the range 0 to less than 1 (inclusive of 0, but not 1)
  doSample = Math.random() * 100 < sampleRate;

  conversantAnalyticsEnabled = true;
  conversantAnalytics.originEnableAnalytics(config); // call the base class function
};

/**
 * Cleanup code for any timers and caches.
 */
conversantAnalytics.disableAnalytics = function () {
  if (!conversantAnalyticsEnabled) {
    return;
  }

  // Cleanup our caches and disable our timer
  clearInterval(cacheCleanupInterval);
  cleanCache(timeoutCache, Date.now() + MAX_MILLISECONDS_IN_CACHE);
  cleanCache(adIdLookup, Date.now() + MAX_MILLISECONDS_IN_CACHE);

  conversantAnalyticsEnabled = false;
  conversantAnalytics.originDisableAnalytics();
};

adapterManager.registerAnalyticsAdapter({
  adapter: conversantAnalytics,
  code: ANALYTICS_CODE,
  gvlid: GVLID
});

export default conversantAnalytics;
