import {ajax} from 'src/ajax';
import adapter from 'src/AnalyticsAdapter';
import CONSTANTS from 'src/constants.json';
import {getGlobal} from '../src/prebidGlobal.js';
import adaptermanager from 'src/adaptermanager';
import * as utils from "../src/utils";

const {
  EVENTS: { AUCTION_INIT, AUCTION_END, AD_RENDER_FAILED, NO_BID, BID_TIMEOUT, BID_WON }
} = CONSTANTS;

const ANALYTICS_TYPE = 'endpoint';
const URL = 'https://web.hb.ad.cpe.dotomi.com/cvx/event/prebidanalytics';
const ANALYTICS_CODE = 'conversant';
const VERSION = '1.0.0';

let initOptions;

const auctionAnalyticsPayload = {
  auction : {},
  adUnits : [],
};

// <adId> => {bidderCode -> <value>, adUnitCode -> <value>}
const adIdLookup = {};

//Hash lookup of bids by "<adUnitCode>-<bidderCode>" to simplify aggregating data before sending it back to server
const bidsLookup = {};

let conversantAnalytics = Object.assign(
  adapter({URL, ANALYTICS_TYPE}),
  {
    track({ eventType, args }) {
      utils.logMessage(eventType, Object.assign({}, args));
      switch (eventType) {
        case AUCTION_INIT:
          onAuctionInit(args);
          break;
        case AUCTION_END:
          onAuctionEnd(args);
          break;
        case AD_RENDER_FAILED:
          onAdRenderFailed(args);
          break;
        case NO_BID:
          onNoBid(args);
          break;
        case BID_TIMEOUT:
          onBidTimeout(args);
          break;
        case BID_WON:
          onBidWon(args);
          break;
      }
    }
  }
);


//================================================== EVENT HANDLERS ====================================================

function onAuctionInit(auctionInitData){
  auctionAnalyticsPayload.auction.auctionId = auctionInitData.auctionId;
  auctionAnalyticsPayload.auction.preBidVersion = getGlobal().version;
  auctionAnalyticsPayload.auction.preBidAnalyticsVersion = VERSION;
  auctionAnalyticsPayload.auction.cnvrPrebidVersion = 0; //TODO: how do we get this?
  auctionAnalyticsPayload.auction.siteId = 0; // TODO: where do we get this?

  auctionInitData.adUnits.forEach( adUnit => {
    const cnvrAdUnit = {};
    //Pre-initialize bidsLookup with adUnits
    bidsLookup[adUnit.code] = {};
    cnvrAdUnit.adCode = adUnit.code;
    cnvrAdUnit.sizes = [];
    cnvrAdUnit.bids = [];
    if (isArray(adUnit.sizes) && adUnit.sizes.length >= 1) {
      let adSizes = adUnit.sizes;
      //Handle case where it's just 1 size so it is [400,600], just warp it in another array to keep logic the same as a
      //list of size arrays i.e. [[400,600]] or [[400,600],[200,300]]
      if (!isArray(adSizes)){
        adSizes = [adSizes];
      }
      adSizes.forEach(size => {
        if (size.length != 2) {
          //error handle
          return; //skips to next item
        }
        cnvrAdUnit.sizes.push({
          w: size[0],
          h: size[1]
        });
      });
    }

    auctionAnalyticsPayload.adUnits.push(cnvrAdUnit);
  });
}

/**
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
function onBidTimeout(args){
  if (typeof args === 'object' && args !== null){
    args = [args];
  }

  if (isArray(args)){
    args.forEach(bid => {
      if ('bidder' in bid && 'adUnitCode' in bid) {
        const bidderCode = bid.bidder;
        const adUnitCode = bid.adUnitCode;
        initializeBidDefaults(adUnitCode, bidderCode);
        bidsLookup[adUnitCode][bidderCode].didTimeout = 1;
      } //else can't do anything without those values

    });
  } else {
    //dunno what it could be?
  }
}

function onNoBid(args){
  //Get bid lookup key
  const bidderCode = args.bidder;
  const adUnitCode = args.adUnitCode;
  //TODO: handle adUnitCode not set?
  //TODO: do we need to veriy auctionID?

  if (typeof bidsLookup[adUnitCode][bidderCode] == 'undefined'){
    initializeBidDefaults(adUnitCode, bidderCode);
  }

  bidsLookup[adUnitCode][bidderCode].didNoBid = 1;
}

function onBidWon(args){
  //Get bid lookup key
  const bidderCode = args.bidderCode;
  const adUnitCode = args.adUnitCode;
  //TODO: handle adUnitCode not set?
  //TODO: do we need to veriy auctionID?

  if (typeof bidsLookup[adUnitCode][bidderCode] == 'undefined'){
    initializeBidDefaults(adUnitCode, bidderCode);
  }

  bidsLookup[adUnitCode][bidderCode].didWin = 1;

  if (typeof adIdLookup[args.adId] == 'undefined'){
    //TODO: Could this match more that one adUnitCode?
    adIdLookup[args.adId] = {
      'bidderCode' : bidderCode,
      'adUnitCode' : adUnitCode
    };
  }
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
function onAdRenderFailed(args){
  /*
  if bid is there that is included, but not sure what data is in it, might have bidderCode (as 'bidder')
  if adId is there that is included but not sure how to match that up to adUnitCode, would need to save adId from bidWon I think
   */
  if (typeof args['adId'] != 'undefined'){
    const adUnitCode = adIdLookup[args['adId']]['adUnitCode'];
    const bidderCode = adIdLookup[args['adId']]['bidderCode'];
    initializeBidDefaults(adUnitCode, bidderCode);

    bidsLookup[adUnitCode][bidderCode].renderFailed = 1;
  }
}

function onAuctionEnd(args){
  //Get last bit of data
  args.bidsReceived.forEach( bid => {
    const bidderCode = bid.biddeCode;
    const adUnitCode = bid.adUnitCode;
    initializeBidDefaults(adUnitCode, bidderCode);
    bidsLookup[adUnitCode][bidderCode].timeToRespond = bid.timeToRespond;
    bidsLookup[adUnitCode][bidderCode].originalCpm = bid.originalCpm;
    //TODO: originalCurrency? don't care
    bidsLookup[adUnitCode][bidderCode].cpm = bid.cpm;
    bidsLookup[adUnitCode][bidderCode].currency = bid.currency;
    const adSize = bid.size;
    const adSizeArray = adSize.split('x');
    if (isArray(adSizeArray) && adSizeArray.length == 2){
      bidsLookup[adUnitCode][bidderCode].adSize = {
        'w': adSizeArray[0],
        'h': adSizeArray[1],
      }
    }
  });

  //Push all bids in our lookup object onto our final payload
  for (let adUnitCode in bidsLookup){
    for (let bidderCode in bidsLookup[adUnitCode]){
      auctionAnalyticsPayload.adUnits.bids.push(bidsLookup[adUnitCode][bidderCode]);
    }
  }

  //sendData
  ajax(URL, function () {}, JSON.stringify(auctionAnalyticsPayload), {contentType: 'application/json', method: 'POST'});
}

/**
 * Handle making sure that the object for an adUnitCode and bidderCode is created... if not it creates it.
 * @param adUnitCode code for the adSlot
 * @param bidderCode code for the bidder
 */
function initializeBidDefaults(adUnitCode, bidderCode) {
  if (bidsLookup[adUnitCode] === undefined || bidsLookup[adUnitCode][bidderCode] === undefined) {
    bidsLookup[adUnitCode][bidderCode] = {
      'bidderCode': bidderCode,
      'didWin': 0,
      'didTimeout': 0,
      'renderFailed': 0,
      'didNoBid': 0,
      'adSize': undefined,
      'cpm': undefined,
      'originalCpm': undefined,
      'timeToRespond': undefined,
      'currency': undefined
    };
  }
}

//=============================================== END EVENT HANDLERS ===================================================

// save the base class function
conversantAnalytics.originEnableAnalytics = conversantAnalytics.enableAnalytics;

// override enableAnalytics so we can get access to the config passed in from the page
conversantAnalytics.enableAnalytics = function (config) {
  if (!config || !config.options || !config.options.siteId) {
    utils.logError('Conversant analytics adapter: siteId is required.');
    return;
  }

  initOptions = config.options;
  conversantAnalytics.originEnableAnalytics(config);  // call the base class function
};

adaptermanager.registerAnalyticsAdapter({
  adapter: conversantAnalytics,
  code: ANALYTICS_CODE
});
