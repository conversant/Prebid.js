import {ajax} from '../src/ajax.js';
import adapter from '../src/AnalyticsAdapter.js';
import CONSTANTS from '../src/constants.json';
import {getGlobal} from '../src/prebidGlobal.js';
import adapterManager from '../src/adapterManager.js';
import * as utils from '../src/utils.js';

const {
  EVENTS: { AUCTION_END, AD_RENDER_FAILED, BID_TIMEOUT, BID_WON }
} = CONSTANTS;

const ANALYTICS_TYPE = 'endpoint';
const URL = 'https://web.hb.ad.cpe.dotomi.com/cvx/event/prebidanalytics';
//const URL = 'http://127.0.0.1:8290/cvx/event/prebidanalytics';
const ANALYTICS_CODE = 'conversant';
// const VERSION = '1.0.0';

// TODO: add clean-up timer for 'timeoutCache' and 'adIdLookup'
const MAX_MILLISECONDS_IN_CACHE = 30000;
const CACHE_CLEANUP_TIME_IN_MILLIS = 30000;

// BID STATUS CODES
// const CNVR_UNKNOWN = 0;
const CNVR_WIN = 10;
const CNVR_BID = 20;
const CNVR_NO_BID = 30;
const CNVR_TIMEOUT = 40;
const CNVR_RENDER_FAILED = 50;

let initOptions;

// <adId> => {bidderCode -> <value>, adUnitCode -> <value>}
const adIdLookup = {};

// timeoutCache[auctionId][adUnitCode][bidder].timeReceived = timeSent (for cache cleanup)
const timeoutCache = {};

let conversantAnalytics = Object.assign(
  adapter({URL, ANALYTICS_TYPE}),
  {
    track({ eventType, args }) {
      utils.logMessage(eventType, Object.assign({}, args));
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
      }
    }
  }
);

setInterval(
  function() {
    const currTime = Date.now();
    cleanCache(adIdLookup, currTime);
    cleanCache(timeoutCache, currTime);
  },
  CACHE_CLEANUP_TIME_IN_MILLIS
);

function cleanCache(cacheObj, currTime) {
  for (let key in cacheObj) {
    const timeInCache = currTime - cacheObj[key].timeReceived;
    //TODO: fix warning
    if (timeInCache >= MAX_MILLISECONDS_IN_CACHE) {
      delete cacheObj[key];
    }
  }
}

// ================================================== EVENT HANDLERS ====================================================
/**
 * We get the list of timeouts before the endAution, cache them temporarily in a global cache and the endAuction event
 * will pick them up.
 *
 * Sample showed this as an array but I'm guessing it could be an array or just a single object so we need to handle
 * both
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
 * Bid won occurs after auctionEnd so we need to send this separately.
 * @param args
 */
function onBidWon(args) {
  const bidderCode = args.bidderCode;
  const adUnitCode = args.adUnitCode;
  if (typeof bidderCode === 'undefined' || typeof adUnitCode === 'undefined') {
    return;
  }
  const bidWonPayload = createPayload('bid_won', args.auctionId);

  bidWonPayload.adUnits[adUnitCode] = createAdUnit();

  const bidPayload = initializeBidDefaults();
  bidPayload.eventCodes.push(CNVR_WIN);
  bidPayload.adSize = createAdSize(args.width, args.height);
  bidPayload.cpm = args.cpm;
  bidPayload.originalCpm = args.originalCpm;
  bidPayload.currency = args.currency;
  bidPayload.timeToRespond = args.timeToRespond;
  bidWonPayload.adUnits[adUnitCode].bids[bidderCode] = bidPayload;

  if (typeof adIdLookup[args.adId] === 'undefined') {
    // TODO: Could this match more that one  ?
    adIdLookup[args.adId] = {
      'bidderCode': bidderCode,
      'adUnitCode': adUnitCode,
      'auctionId': args.auctionId,
      'timeReceived': Date.now() // For cache cleaning
    };
  }

  sendData(bidWonPayload);
}

/**
 *
 * @param args = {
 *  reason: <value>
 *  message: <value>
 *  adId: <value> --optional
 *  bid: {object?} --optional: unsure what this looks like but guessing it is {bidder: <value>, params: {object}}
 *    }
 */
function onAdRenderFailed(args) {
  /*
  if bid is there that is included, but not sure what data is in it, might have bidderCode (as 'bidder')
  if adId is there that is included but not sure how to match that up to adUnitCode, would need to save adId from bidWon I think
   */
  if (typeof args['adId'] === 'undefined' || typeof adIdLookup[args['adId']] === 'undefined') {
    return; // Either no adId to match against a bidWon event, or no data saved from a bidWon event that matches the adId
  }
  const adUnitCode = adIdLookup[args['adId']]['adUnitCode'];
  const bidderCode = adIdLookup[args['adId']]['bidderCode'];
  const auctionId = adIdLookup[args['adId']]['auctionId'];
  delete adIdLookup[args['adId']];

  if (typeof bidderCode === 'undefined' || typeof adUnitCode === 'undefined') {
    return;
  }

  const renderFailedPayload = createPayload('render_failed', auctionId);
  renderFailedPayload.adUnits[adUnitCode] = createAdUnit();
  renderFailedPayload.adUnits[adUnitCode].bids[bidderCode] = initializeBidDefaults();
  renderFailedPayload.adUnits[adUnitCode].bids[bidderCode].eventCodes.push(CNVR_RENDER_FAILED);

  sendData(renderFailedPayload);
}

function onAuctionEnd(args) {
  const auctionEndPayload = createPayload('auction_end', args.auctionId);

  // Get bid request information from adUnits
  args.adUnits.forEach(adUnit => {
    const cnvrAdUnit = createAdUnit();
    // TODO: we can just get sizes, but can there be multiple mediatypes? Banner? video? ever mixed?

    // Initialize bids with bidderCode
    adUnit.bids.forEach(bid => {
      cnvrAdUnit.bids[bid.bidder] = initializeBidDefaults();

      // Check for cached timeout responses
      const timeoutKey = getLookupKey(args.auctionId, adUnit.code, bid.bidder);
      if (typeof timeoutCache[timeoutKey] !== 'undefined') {
        cnvrAdUnit.bids[bid.bidder].eventCodes.push(CNVR_TIMEOUT);
        delete timeoutCache[timeoutKey];
      }
    });

    if (Array.isArray(adUnit.sizes) && adUnit.sizes.length >= 1) {
      let adSizes = adUnit.sizes;
      // Handle case where it's just 1 size so it is [400,600], just warp it in another array to keep logic the same as a
      // list of size arrays i.e. [[400,600]] or [[400,600],[200,300]]
      if (!Array.isArray(adSizes[0])) {
        adSizes = [adSizes];
      }
      adSizes.forEach(size => {
        //TODO: fix warning
        if (size.length != 2) {
          // error handle
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

  args.noBids.forEach(noBid => {
    // TODO: verify it exists
    auctionEndPayload.adUnits[noBid.adUnitCode].bids[noBid.bidder].eventCodes.push(CNVR_NO_BID);
  });

  // Get bid data from bids sent
  args.bidsReceived.forEach(bid => {
    // TODO: verify it exists
    const bidPayload = auctionEndPayload.adUnits[bid.adUnitCode].bids[bid.bidderCode];
    bidPayload.eventCodes.push(CNVR_BID);
    bidPayload.timeToRespond = bid.timeToRespond;
    bidPayload.originalCpm = bid.originalCpm;
    bidPayload.cpm = bid.cpm;
    bidPayload.currency = bid.currency;
    bidPayload.adSize = {
      'w': bid.width,
      'h': bid.height
    };
  });

  sendData(auctionEndPayload);
}

function getLookupKey(auctionId, adUnitCode, bidderCode) {
  return auctionId + '-' + adUnitCode + '-' + bidderCode;
}

function createPayload(payloadType, auctionId) {
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

function createAdSize(width, height) {
  return {
    'w': width,
    'h': height
  };
}

function createAdUnit() {
  return {
    sizes: [],
    bids: {}
  };
}

/**
 * Handle making sure that the object for an adUnitCode and bidderCode is created... if not it creates it.
 */
function initializeBidDefaults() {
  return {
    'eventCodes': [],
    'adSize': undefined,
    'cpm': undefined,
    'originalCpm': undefined,
    'currency': undefined,
    'timeToRespond': undefined
  };
}

// =============================================== END EVENT HANDLERS ===================================================

function sendData(payload) {
  // sendData
  ajax(URL, function () {}, JSON.stringify(payload), {contentType: 'text/plain'});
}

// save the base class function
conversantAnalytics.originEnableAnalytics = conversantAnalytics.enableAnalytics;

// override enableAnalytics so we can get access to the config passed in from the page
conversantAnalytics.enableAnalytics = function (config) {
  if (!config || !config.options || !config.options.site_id) {
    utils.logError('Conversant analytics adapter: siteId is required.');
    return;
  }

  initOptions = config.options;
  conversantAnalytics.originEnableAnalytics(config); // call the base class function
};

adapterManager.registerAnalyticsAdapter({
  adapter: conversantAnalytics,
  code: ANALYTICS_CODE
});
