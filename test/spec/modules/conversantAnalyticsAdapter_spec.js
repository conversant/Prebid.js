import sinon from 'sinon';
import {expect} from 'chai';
import {getGlobal} from 'src/prebidGlobal.js';
import conversantAnalytics from 'modules/conversantAnalyticsAdapter.js';
import * as caObj from 'modules/conversantAnalyticsAdapter.js';
import * as utils from 'src/utils.js';
import * as prebidGlobal from 'src/prebidGlobal';
import events from 'src/events';
import constants from 'src/constants.json'

describe('Conversant analytics adapter tests', function() {
  let sandbox; // sinon sandbox to make restoring all stubbed objects eaiser
  let xhr; // xhr stub from sinon for capturing data sent via ajax
  let clock; // clock stub from sinon to mock our cache cleanup interval

  const PREBID_VERSION = '1.2';
  const SITE_ID = 108060;

  let requests = [];
  const DATESTAMP = Date.now();

  let VALID_CONFIGURATION = {
    options: {
      site_id: SITE_ID
    }
  };

  let VALID_ALWAYS_SAMPLE_CONFIG = {
    options: {
      site_id: SITE_ID,
      sampleRate: 100
    }
  };

  beforeEach(function () {
    sandbox = sinon.sandbox.create();
    sandbox.stub(events, 'getEvents').returns([]); // need to stub this otherwise unwanted events seem to get fired during testing
    xhr = sandbox.useFakeXMLHttpRequest(); // allows us to capture ajax requests
    xhr.onCreate = function (req) { requests.push(req); }; // save ajax requests in a private array for testing purposes
    let getGlobalStub = {
      version: PREBID_VERSION,
      getUserIds: function() { // userIdTargeting.js init() gets called on AUCTION_END so we need to mock this function.
        return {};
      }
    };
    sandbox.stub(prebidGlobal, 'getGlobal').returns(getGlobalStub); // getGlobal does not seem to be available in testing so need to mock it
    clock = sandbox.useFakeTimers(DATESTAMP); // to use sinon fake timers they MUST be created before the interval/timeout is created in the code you are testing.
  });

  afterEach(function () {
    sandbox.restore();
    requests = []; // clean up any requests in our ajax request capture array.
  });

  describe('Initialization Tests', function() {
    it('should log error if publisher id is not passed', function() {
      sandbox.stub(utils, 'logError');

      conversantAnalytics.enableAnalytics();
      expect(utils.logError.calledWith(caObj.LOG_PREFIX + 'siteId is required.')).to.be.true;
      conversantAnalytics.disableAnalytics();
    });

    it('should not log error if valid config is passed', function() {
      sandbox.stub(utils, 'logError');
      sandbox.stub(utils, 'logInfo');

      conversantAnalytics.enableAnalytics(VALID_CONFIGURATION);
      expect(utils.logError.called).to.equal(false);
      expect(utils.logInfo.called).to.equal(true);
      expect(
        utils.logInfo.calledWith(
          caObj.LOG_PREFIX + 'Sample rate set to ' + caObj.DEFAULT_SAMPLE_RATE + '%'
        )
      ).to.be.true;
      conversantAnalytics.disableAnalytics();
    });

    it('should sample when sampling set to 1', function() {
      sandbox.stub(utils, 'logError');

      VALID_CONFIGURATION.options.sampleRate = 100;
      conversantAnalytics.enableAnalytics(VALID_CONFIGURATION);
      expect(utils.logError.called).to.equal(false);
      expect(caObj.DO_SAMPLE).to.equal(true);
      conversantAnalytics.disableAnalytics();
      delete VALID_CONFIGURATION.options.sampleRate;
    });

    it('should NOT sample when sampling set to 0', function() {
      sandbox.stub(utils, 'logError');

      VALID_CONFIGURATION.options.sampleRate = 0;
      conversantAnalytics.enableAnalytics(VALID_CONFIGURATION);
      expect(utils.logError.called).to.equal(false);
      expect(caObj.DO_SAMPLE).to.equal(false);
      conversantAnalytics.disableAnalytics();
      delete VALID_CONFIGURATION.options.sampleRate;
    });
  });

  describe('Helper Function Tests', function() {
    it('should cleanup up cache objects', function() {
      conversantAnalytics.enableAnalytics(VALID_CONFIGURATION);

      caObj.adIdLookup['keep'] = {timeReceived: DATESTAMP + 1};
      caObj.adIdLookup['delete'] = {timeReceived: DATESTAMP - caObj.MAX_MILLISECONDS_IN_CACHE};

      caObj.timeoutCache['keep'] = {timeReceived: DATESTAMP + 1};
      caObj.timeoutCache['delete'] = {timeReceived: DATESTAMP - caObj.MAX_MILLISECONDS_IN_CACHE};

      expect(Object.keys(caObj.adIdLookup).length).to.equal(2);
      expect(Object.keys(caObj.timeoutCache).length).to.equal(2);

      clock.tick(caObj.CACHE_CLEANUP_TIME_IN_MILLIS);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(1);
      expect(Object.keys(caObj.timeoutCache).length).to.equal(1);

      conversantAnalytics.disableAnalytics();

      // After disable we should cleanup the cache
      expect(Object.keys(caObj.adIdLookup).length).to.equal(0);
      expect(Object.keys(caObj.timeoutCache).length).to.equal(0);
    });

    it('isInt() should return true', function() {
      expect(caObj.isInt(1)).to.equal(true);
      expect(caObj.isInt(0)).to.equal(true);
      expect(caObj.isInt(-1)).to.equal(true);
      expect(caObj.isInt(111)).to.equal(true);
      expect(caObj.isInt(1.0)).to.equal(true);
    });

    it('isInt() should return false', function() {
      expect(caObj.isInt(0.1)).to.equal(false);
      expect(caObj.isInt(1.1)).to.equal(false);
      expect(caObj.isInt('foo')).to.equal(false);
      expect(caObj.isInt(undefined)).to.equal(false);
      expect(caObj.isInt(false)).to.equal(false);
    });

    it('initializeBidDefaults() should return correct object', function() {
      let bid = caObj.initializeBidDefaults();
      expect(Array.isArray(bid.eventCodes)).to.equal(true);
      expect(bid.eventCodes.length).to.equal(0);
      expect(Object.keys(bid).length).to.equal(1);
    });

    it('createAdUnit() should return correct object', function() {
      let adUnit = caObj.createAdUnit();
      expect(Array.isArray(adUnit.sizes)).to.equal(true);
      expect(adUnit.sizes.length).to.equal(0);
      expect(typeof adUnit.bids).to.equal('object');
      expect(Object.keys(adUnit.bids).length).to.equal(0);
      expect(Object.keys(adUnit).length).to.equal(2);
    });

    it('createAdSize() should return correct object', function() {
      let adSize = caObj.createAdSize(1, 2);
      expect(adSize.w).to.equal(1);
      expect(adSize.h).to.equal(2);
      expect(Object.keys(adSize).length).to.equal(2);

      adSize = caObj.createAdSize();
      expect(adSize.w).to.equal(-1);
      expect(adSize.h).to.equal(-1);

      adSize = caObj.createAdSize('foo', 'bar');
      expect(adSize.w).to.equal(-1);
      expect(adSize.h).to.equal(-1);
    });

    it('getLookupKey() should return correct object', function() {
      let foo; // undefined var
      let key = caObj.getLookupKey(foo, foo, foo);
      expect(key).to.equal('undefined-undefined-undefined');

      key = caObj.getLookupKey('foo', 'bar', 'baz');
      expect(key).to.equal('foo-bar-baz');
    });

    it('createPayload() should return correct object', function() {
      const REQUEST_TYPE = 'foo';
      const AUCTION_ID = '124 abc';
      conversantAnalytics.enableAnalytics(VALID_ALWAYS_SAMPLE_CONFIG);

      let payload = caObj.createPayload(REQUEST_TYPE, AUCTION_ID);
      expect(payload.requestType).to.equal(REQUEST_TYPE);
      expect(payload.auction.auctionId).to.equal(AUCTION_ID);
      expect(payload.auction.preBidVersion).to.equal(PREBID_VERSION);
      expect(payload.auction.sid).to.equal(VALID_ALWAYS_SAMPLE_CONFIG.options.site_id);
      expect(Object.keys(payload.auction).length).to.equal(3);

      expect(typeof payload.adUnits).to.equal('object');
      expect(Object.keys(payload.adUnits).length).to.equal(0);

      expect(Object.keys(payload).length).to.equal(3);

      conversantAnalytics.disableAnalytics();
    });

    it('cleanCache() should purge old objects and not new ones', function() {
      const CURR_TIME = Date.now();
      const EXPIRED_TIME = CURR_TIME - caObj.MAX_MILLISECONDS_IN_CACHE;
      let cacheObj = {};
      cacheObj.foo = { timeReceived: CURR_TIME };
      cacheObj.bar = { timeReceived: EXPIRED_TIME };

      caObj.cleanCache(cacheObj, CURR_TIME);

      expect(Object.keys(cacheObj).length).to.equal(1);
      expect(cacheObj.foo).to.not.be.undefined;
      expect(cacheObj.bar).to.be.undefined;
    });
  });

  describe('Bid Timeout Event Tests', function() {
    const bidTimeoutPayload = [{
      'bidId': '80882409358b8a8',
      'bidder': 'conversant',
      'adUnitCode': 'MedRect',
      'auctionId': 'afbd6e0b-e45b-46ab-87bf-c0bac0cb8881'
    }, {
      'bidId': '9da4c107a6f24c8',
      'bidder': 'conversant',
      'adUnitCode': 'Leaderboard',
      'auctionId': 'afbd6e0b-e45b-46ab-87bf-c0bac0cb8881'
    }
    ];

    beforeEach(function () {
      conversantAnalytics.enableAnalytics(VALID_ALWAYS_SAMPLE_CONFIG);
    });

    afterEach(function () {
      conversantAnalytics.disableAnalytics();
    });

    it('should put both items in timeout cache', function() {
      expect(Object.keys(caObj.timeoutCache).length).to.equal(0);
      events.emit(constants.EVENTS.BID_TIMEOUT, bidTimeoutPayload);
      expect(Object.keys(caObj.timeoutCache).length).to.equal(2);
      expect(requests.length).to.equal(0);
    });
  });

  describe('Render Failed Tests', function() {
    const RENDER_FAILED_PAYLOAD = {
      reason: 'reason',
      message: 'value',
      adId: '57e03aeafd83a68'
    };

    const RENDER_FAILED_PAYLOAD_NO_ADID = {
      reason: 'reason',
      message: 'value'
    };

    beforeEach(function () {
      conversantAnalytics.enableAnalytics(VALID_ALWAYS_SAMPLE_CONFIG);
    });

    afterEach(function () {
      conversantAnalytics.disableAnalytics();
    });

    it('should empty adIdLookup and send data', function() {
      caObj.adIdLookup[RENDER_FAILED_PAYLOAD.adId] = {
        bidderCode: 'bidderCode',
        adUnitCode: 'adUnitCode',
        auctionId: 'auctionId',
        timeReceived: Date.now()
      };

      expect(Object.keys(caObj.adIdLookup).length).to.equal(1);
      events.emit(constants.EVENTS.AD_RENDER_FAILED, RENDER_FAILED_PAYLOAD);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(0); // object should be removed
      expect(requests.length).to.equal(1);
      const data = JSON.parse(requests[0].requestBody);

      expect(data.auction.auctionId).to.equal('auctionId');
      expect(data.auction.preBidVersion).to.equal(PREBID_VERSION);
      expect(data.auction.sid).to.equal(SITE_ID);
      expect(data.adUnits['adUnitCode'].bids['bidderCode'].eventCodes.includes(caObj.CNVR_RENDER_FAILED)).to.be.true;
      expect(data.adUnits['adUnitCode'].bids['bidderCode'].message).to.have.lengthOf.above(0);
    });

    it('should not send data if no adId', function() {
      caObj.adIdLookup[RENDER_FAILED_PAYLOAD.adId] = {
        bidderCode: 'bidderCode',
        adUnitCode: 'adUnitCode',
        auctionId: 'auctionId',
        timeReceived: Date.now()
      };

      expect(Object.keys(caObj.adIdLookup).length).to.equal(1);
      events.emit(constants.EVENTS.AD_RENDER_FAILED, RENDER_FAILED_PAYLOAD_NO_ADID);
      expect(requests.length).to.equal(0);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(1); // object should be removed
    });

    it('should not send data if bad data in lookup', function() {
      caObj.adIdLookup[RENDER_FAILED_PAYLOAD.adId] = {
        bidderCode: 'bidderCode',
        auctionId: 'auctionId',
        timeReceived: Date.now()
      };
      expect(requests.length).to.equal(0);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(1);
      events.emit(constants.EVENTS.AD_RENDER_FAILED, RENDER_FAILED_PAYLOAD);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(0); // object should be removed but no call made to send data
      expect(requests.length).to.equal(0);
    });
  });

  describe('Bid Won Tests', function() {
    const GOOD_BID_WON_ARGS = {
      bidderCode: 'conversant',
      width: 300,
      height: 250,
      statusMessage: 'Bid available',
      adId: '57e03aeafd83a68',
      requestId: '2c2a5485a076898',
      mediaType: 'banner',
      source: 'client',
      currency: 'USD',
      cpm: 4,
      creativeId: '29123_55016759',
      ttl: 300,
      netRevenue: true,
      ad: '<foobar add goes here />',
      originalCpm: 0.04,
      originalCurrency: 'USD',
      auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
      responseTimestamp: 1583851418626,
      requestTimestamp: 1583851418292,
      bidder: 'conversant',
      adUnitCode: 'div-gpt-ad-1460505748561-0',
      timeToRespond: 334,
      pbLg: '4.00',
      pbMg: '4.00',
      pbHg: '4.00',
      pbAg: '4.00',
      pbDg: '4.00',
      pbCg: '',
      size: '300x250',
      adserverTargeting: {
        hb_bidder: 'conversant',
        hb_adid: '57e03aeafd83a68',
        hb_pb: '4.00',
        hb_size: '300x250',
        hb_source: 'client',
        hb_format: 'banner'
      },
      status: 'rendered',
      params: [
        {
          site_id: '108060'
        }
      ]
    };

    // no adUnitCode, auctionId or bidderCode will cause a failure
    const BAD_BID_WON_ARGS = {
      bidderCode: 'conversant',
      width: 300,
      height: 250,
      statusMessage: 'Bid available',
      adId: '57e03aeafd83a68',
      requestId: '2c2a5485a076898',
      mediaType: 'banner',
      source: 'client',
      currency: 'USD',
      cpm: 4,
      originalCpm: 0.04,
      originalCurrency: 'USD',
      bidder: 'conversant',
      adUnitCode: 'div-gpt-ad-1460505748561-0',
      size: '300x250',
      status: 'rendered',
      params: [
        {
          site_id: '108060'
        }
      ]
    };

    beforeEach(function () {
      conversantAnalytics.enableAnalytics(VALID_ALWAYS_SAMPLE_CONFIG);
    });

    afterEach(function () {
      conversantAnalytics.disableAnalytics();
    });

    it('should not send data or put a record in adIdLookup when bad data provided', function() {
      expect(requests.length).to.equal(0);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(0);
      events.emit(constants.EVENTS.BID_WON, BAD_BID_WON_ARGS);
      expect(requests.length).to.equal(0);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(0);
    });

    it('should send data and put a record in adIdLookup', function() {
      expect(requests.length).to.equal(0);
      expect(Object.keys(caObj.adIdLookup).length).to.equal(0);
      events.emit(constants.EVENTS.BID_WON, GOOD_BID_WON_ARGS);

      // Check that adIdLookup was set correctly
      expect(Object.keys(caObj.adIdLookup).length).to.equal(1);
      expect(caObj.adIdLookup[GOOD_BID_WON_ARGS.adId].auctionId).to.equal(GOOD_BID_WON_ARGS.auctionId);
      expect(caObj.adIdLookup[GOOD_BID_WON_ARGS.adId].adUnitCode).to.equal(GOOD_BID_WON_ARGS.adUnitCode);
      expect(caObj.adIdLookup[GOOD_BID_WON_ARGS.adId].bidderCode).to.equal(GOOD_BID_WON_ARGS.bidderCode);
      expect(caObj.adIdLookup[GOOD_BID_WON_ARGS.adId].timeReceived).to.not.be.undefined;

      expect(requests.length).to.equal(1);
      const data = JSON.parse(requests[0].requestBody);
      expect(data.requestType).to.equal('bid_won');
      expect(data.auction.auctionId).to.equal(GOOD_BID_WON_ARGS.auctionId);
      expect(data.auction.preBidVersion).to.equal(PREBID_VERSION);
      expect(data.auction.sid).to.equal(VALID_ALWAYS_SAMPLE_CONFIG.options.site_id);

      expect(typeof data.adUnits).to.equal('object');
      expect(Object.keys(data.adUnits).length).to.equal(1);

      expect(Object.keys(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids).length).to.equal(1);
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].eventCodes.includes(caObj.CNVR_WIN)).to.be.true;
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].cpm).to.equal(GOOD_BID_WON_ARGS.cpm);
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].originalCpm).to.equal(GOOD_BID_WON_ARGS.originalCpm);
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].currency).to.equal(GOOD_BID_WON_ARGS.currency);
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].timeToRespond).to.equal(GOOD_BID_WON_ARGS.timeToRespond);
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].adSize.w).to.equal(GOOD_BID_WON_ARGS.width);
      expect(data.adUnits[GOOD_BID_WON_ARGS.adUnitCode].bids[GOOD_BID_WON_ARGS.bidderCode].adSize.h).to.equal(GOOD_BID_WON_ARGS.height);
    });
  });

  describe('Auction End Tests', function() {
    const AUCTION_END_PAYLOAD = {
      auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
      timestamp: 1583851418288,
      auctionEnd: 1583851418628,
      auctionStatus: 'completed',
      adUnits: [
        {
          code: 'div-gpt-ad-1460505748561-0',
          mediaTypes: {
            banner: {
              sizes: [
                [
                  300,
                  250
                ]
              ]
            }
          },
          bids: [
            {
              bidder: 'appnexus',
              params: {
                placementId: 13144370
              }
            },
            {
              bidder: 'conversant',
              params: {
                site_id: '108060'
              }
            }
          ],
          sizes: [
            [
              300,
              250
            ]
          ],
          transactionId: '5fa8a7d7-2a73-4d1c-b73a-ff9f5b53ba17'
        }
      ],
      adUnitCodes: [
        'div-gpt-ad-1460505748561-0'
      ],
      bidderRequests: [
        {
          bidderCode: 'conversant',
          auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
          bidderRequestId: '13f16db358d4c58',
          bids: [
            {
              bidder: 'conversant',
              params: {
                site_id: '108060'
              },
              mediaTypes: {
                banner: {
                  sizes: [
                    [
                      300,
                      250
                    ]
                  ]
                }
              },
              adUnitCode: 'div-gpt-ad-1460505748561-0',
              transactionId: '5fa8a7d7-2a73-4d1c-b73a-ff9f5b53ba17',
              sizes: [
                [
                  300,
                  250
                ]
              ],
              bidId: '2c2a5485a076898',
              bidderRequestId: '13f16db358d4c58',
              auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
              src: 'client',
              bidRequestsCount: 1,
              bidderRequestsCount: 1,
              bidderWinsCount: 0
            }
          ],
          auctionStart: 1583851418288,
          timeout: 3000,
          refererInfo: {
            referer: 'http://localhost:9999/integrationExamples/gpt/hello_analytics1.html',
            reachedTop: true,
            numIframes: 0,
            stack: [
              'http://localhost:9999/integrationExamples/gpt/hello_analytics1.html'
            ]
          },
          start: 1583851418292
        },
        {
          bidderCode: 'appnexus',
          auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
          bidderRequestId: '3e8179f67f31b98',
          bids: [
            {
              bidder: 'appnexus',
              params: {
                placementId: 13144370
              },
              mediaTypes: {
                banner: {
                  sizes: [
                    [
                      300,
                      250
                    ]
                  ]
                }
              },
              adUnitCode: 'div-gpt-ad-1460505748561-0',
              transactionId: '5fa8a7d7-2a73-4d1c-b73a-ff9f5b53ba17',
              sizes: [
                [
                  300,
                  250
                ]
              ],
              bidId: '40a1d3ac6b79668',
              bidderRequestId: '3e8179f67f31b98',
              auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
              src: 'client',
              bidRequestsCount: 1,
              bidderRequestsCount: 1,
              bidderWinsCount: 0
            }
          ],
          auctionStart: 1583851418288,
          timeout: 3000,
          refererInfo: {
            referer: 'http://localhost:9999/integrationExamples/gpt/hello_analytics1.html',
            reachedTop: true,
            numIframes: 0,
            stack: [
              'http://localhost:9999/integrationExamples/gpt/hello_analytics1.html'
            ]
          },
          start: 1583851418295
        }
      ],
      noBids: [
        {
          bidder: 'appnexus',
          params: {
            placementId: 13144370
          },
          mediaTypes: {
            banner: {
              sizes: [
                [
                  300,
                  250
                ]
              ]
            }
          },
          adUnitCode: 'div-gpt-ad-1460505748561-0',
          transactionId: '5fa8a7d7-2a73-4d1c-b73a-ff9f5b53ba17',
          sizes: [
            [
              300,
              250
            ]
          ],
          bidId: '40a1d3ac6b79668',
          bidderRequestId: '3e8179f67f31b98',
          auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
          src: 'client',
          bidRequestsCount: 1,
          bidderRequestsCount: 1,
          bidderWinsCount: 0
        }
      ],
      bidsReceived: [
        {
          bidderCode: 'conversant',
          width: 300,
          height: 250,
          statusMessage: 'Bid available',
          adId: '57e03aeafd83a68',
          requestId: '2c2a5485a076898',
          mediaType: 'banner',
          source: 'client',
          currency: 'USD',
          cpm: 4,
          creativeId: '29123_55016759',
          ttl: 300,
          netRevenue: true,
          ad: '<foobar add goes here />',
          originalCpm: 0.04,
          originalCurrency: 'USD',
          auctionId: '85e1bf44-4035-4e24-bd3c-b1ba367fe294',
          responseTimestamp: 1583851418626,
          requestTimestamp: 1583851418292,
          bidder: 'conversant',
          adUnitCode: 'div-gpt-ad-1460505748561-0',
          timeToRespond: 334,
          pbLg: '4.00',
          pbMg: '4.00',
          pbHg: '4.00',
          pbAg: '4.00',
          pbDg: '4.00',
          pbCg: '',
          size: '300x250',
          adserverTargeting: {
            hb_bidder: 'conversant',
            hb_adid: '57e03aeafd83a68',
            hb_pb: '4.00',
            hb_size: '300x250',
            hb_source: 'client',
            hb_format: 'banner'
          }
        }
      ],
      winningBids: [],
      timeout: 3000
    };

    beforeEach(function () {
      conversantAnalytics.enableAnalytics(VALID_ALWAYS_SAMPLE_CONFIG);
    });

    afterEach(function () {
      conversantAnalytics.disableAnalytics();
    });

    it('should not do anything when auction id doesnt exist', function() {
      sandbox.stub(utils, 'logError');

      let BAD_ARGS = JSON.parse(JSON.stringify(AUCTION_END_PAYLOAD));
      delete BAD_ARGS.auctionId;
      expect(requests.length).to.equal(0);
      events.emit(constants.EVENTS.AUCTION_END, BAD_ARGS);
      expect(requests.length).to.equal(0);
      expect(
        utils.logError.calledWith(
          caObj.LOG_PREFIX + 'onAuctionEnd(): No auctionId in args supplied so unable to process event.'
        )
      ).to.be.true;
    });

    it('should send the expected data', function() {
      sandbox.stub(utils, 'logError');
      expect(requests.length).to.equal(0);
      const AUCTION_ID = AUCTION_END_PAYLOAD.auctionId;
      const AD_UNIT_CODE = AUCTION_END_PAYLOAD.adUnits[0].code;
      const timeoutKey = caObj.getLookupKey(AUCTION_ID, AD_UNIT_CODE, 'appnexus');
      caObj.timeoutCache[timeoutKey] = { timeReceived: Date.now() };
      expect(Object.keys(caObj.timeoutCache).length).to.equal(1);
      expect(utils.logError.called).to.equal(false);

      events.emit(constants.EVENTS.AUCTION_END, AUCTION_END_PAYLOAD);
      // expect(utils.logError.callCount).to.equal(1);
      /* utils.logError.getCall(0).args.forEach(arg => {
        console.log("foobar: " + arg);
      }); */
      // expect(utils.logError.getCall(0).args[0]).to.equal('foobar');
      expect(utils.logError.called).to.equal(false);
      expect(requests.length).to.equal(1);
      expect(Object.keys(caObj.timeoutCache).length).to.equal(0);

      const data = JSON.parse(requests[0].requestBody);
      expect(data.requestType).to.equal('auction_end');
      expect(data.auction.auctionId).to.equal(AUCTION_ID);
      expect(data.auction.preBidVersion).to.equal(PREBID_VERSION);
      expect(data.auction.sid).to.equal(VALID_ALWAYS_SAMPLE_CONFIG.options.site_id);

      expect(Object.keys(data.adUnits).length).to.equal(AUCTION_END_PAYLOAD.adUnits.length);

      expect(data.adUnits[AD_UNIT_CODE].sizes.length).to.equal(1);
      expect(data.adUnits[AD_UNIT_CODE].sizes[0].w).to.equal(300);
      expect(data.adUnits[AD_UNIT_CODE].sizes[0].h).to.equal(250);

      expect(Object.keys(data.adUnits[AD_UNIT_CODE].bids).length).to.equal(2);
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].eventCodes.includes(caObj.CNVR_BID)).to.be.true;
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].cpm).to.equal(4);
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].originalCpm).to.equal(0.04);
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].currency).to.equal('USD');
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].timeToRespond).to.equal(334);
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].adSize.w).to.equal(300);
      expect(data.adUnits[AD_UNIT_CODE].bids['conversant'].adSize.h).to.equal(250);

      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].originalCpm).to.be.undefined;
      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].eventCodes.includes(caObj.CNVR_NO_BID)).to.be.true;
      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].eventCodes.includes(caObj.CNVR_TIMEOUT)).to.be.true;
      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].cpm).to.be.undefined;
      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].currency).to.be.undefined;
      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].timeToRespond).to.equal(0);
      expect(data.adUnits[AD_UNIT_CODE].bids['appnexus'].adSize).to.be.undefined;
    });
  });
});
