import { E, passStyleOf } from '@endo/far';

import { isUpgradeDisconnection } from '@agoric/internal/src/upgrade-api.js';
import { prepareExoClassKit, watchPromise } from '@agoric/vat-data';
import { M } from '@agoric/store';
import {
  PaymentPKeywordRecordShape,
  SeatShape,
} from '@agoric/zoe/src/typeGuards.js';
import { AmountShape } from '@agoric/ertp/src/typeGuards.js';
import { deeplyFulfilledObject, objectMap } from '@agoric/internal';

import { UNPUBLISHED_RESULT } from './offers.js';

/**
 * @typedef {import('./offers.js').OfferSpec & {
 *   error?: string,
 *   numWantsSatisfied?: number
 *   result?: unknown | typeof import('./offers.js').UNPUBLISHED_RESULT,
 *   payouts?: AmountKeywordRecord,
 * }} OfferStatus
 */

/**
 * @template {any} T
 * @typedef {import('@agoric/swingset-liveslots').PromiseWatcher<T, [UserSeat]>} OfferPromiseWatcher<T, [UserSeat]
 */

/**
 * @typedef {{
 * resultWatcher: OfferPromiseWatcher<unknown>,
 * numWantsWatcher: OfferPromiseWatcher<number>,
 * paymentWatcher: OfferPromiseWatcher<PaymentPKeywordRecord>,
 * }} OutcomeWatchers
 */

/**
 * @param {OutcomeWatchers} watchers
 * @param {UserSeat} seat
 */
const watchForOfferResult = ({ resultWatcher }, seat) => {
  const p = E(seat).getOfferResult();
  watchPromise(p, resultWatcher, seat);
  return p;
};

/**
 * @param {OutcomeWatchers} watchers
 * @param {UserSeat} seat
 */
const watchForNumWants = ({ numWantsWatcher }, seat) => {
  const p = E(seat).numWantsSatisfied();
  watchPromise(p, numWantsWatcher, seat);
  return p;
};

/**
 * @param {OutcomeWatchers} watchers
 * @param {UserSeat} seat
 */
const watchForPayout = ({ paymentWatcher }, seat) => {
  const p = E(seat).getPayouts();
  watchPromise(p, paymentWatcher, seat);
  return p;
};

/**
 * @param {OutcomeWatchers} watchers
 * @param {UserSeat} seat
 */
export const watchOfferOutcomes = (watchers, seat) => {
  return Promise.all([
    watchForOfferResult(watchers, seat),
    watchForNumWants(watchers, seat),
    watchForPayout(watchers, seat),
  ]);
};

const offerWatcherGuard = harden({
  helper: M.interface('InstanceAdminStorage', {
    updateStatus: M.call(M.any()).returns(),
    onNewContinuingOffer: M.call(
      M.or(M.number(), M.string()),
      AmountShape,
      M.any(),
    )
      .optional(M.record())
      .returns(),
    publishResult: M.call(M.any()).returns(),
    handleError: M.call(M.error()).returns(),
  }),
  paymentWatcher: M.interface('paymentWatcher', {
    onFulfilled: M.call(PaymentPKeywordRecordShape, SeatShape).returns(
      M.promise(),
    ),
    onRejected: M.call(M.any(), SeatShape).returns(),
  }),
  resultWatcher: M.interface('resultWatcher', {
    onFulfilled: M.call(M.any(), SeatShape).returns(),
    onRejected: M.call(M.any(), SeatShape).returns(),
  }),
  numWantsWatcher: M.interface('numWantsWatcher', {
    onFulfilled: M.call(M.number(), SeatShape).returns(),
    onRejected: M.call(M.any(), SeatShape).returns(),
  }),
});

/**
 * @param {import('@agoric/vat-data').Baggage} baggage
 */
export const prepareOfferWatcher = baggage => {
  return prepareExoClassKit(
    baggage,
    'OfferWatcher',
    offerWatcherGuard,
    /**
     *
     * @param {*} walletHelper
     * @param {*} deposit
     * @param {import('./offers.js').OfferSpec} offerSpec
     * @param {string} address
     * @param {Amount<'set'>} invitationAmount
     * @param {UserSeat} seatRef
     */
    (walletHelper, deposit, offerSpec, address, invitationAmount, seatRef) => ({
      walletHelper,
      deposit,
      status: offerSpec,
      address,
      invitationAmount,
      seatRef,
    }),
    {
      helper: {
        /**
         * @param {Record<string, unknown>} offerStatusUpdates
         */
        updateStatus(offerStatusUpdates) {
          const { state } = this;
          state.status = harden({ ...state.status, ...offerStatusUpdates });

          state.walletHelper.updateStatus(state.status);
        },
        onNewContinuingOffer(
          offerId,
          invitationAmount,
          invitationMakers,
          publicSubscribers,
        ) {
          const { state } = this;

          void state.walletHelper.addContinuingOffer(
            offerId,
            invitationAmount,
            invitationMakers,
            publicSubscribers,
          );
        },

        /** @param {unknown} result */
        publishResult(result) {
          const { state, facets } = this;

          const passStyle = passStyleOf(result);
          // someday can we get TS to type narrow based on the passStyleOf result match?
          switch (passStyle) {
            case 'bigint':
            case 'boolean':
            case 'null':
            case 'number':
            case 'string':
            case 'symbol':
            case 'undefined':
              facets.helper.updateStatus({ result });
              break;
            case 'copyRecord':
              // @ts-expect-error narrowed by passStyle
              if ('invitationMakers' in result) {
                // save for continuing invitation offer

                void facets.helper.onNewContinuingOffer(
                  String(state.status.id),
                  state.invitationAmount,
                  result.invitationMakers,
                  // @ts-expect-error narrowed by passStyle
                  result.publicSubscribers,
                );
              }
              facets.helper.updateStatus({ result: UNPUBLISHED_RESULT });
              break;
            default:
              // drop the result
              facets.helper.updateStatus({ result: UNPUBLISHED_RESULT });
          }
        },
        /**
         * Called when the offer result promise rejects. The other two watchers
         * are waiting for particular values out of Zoe but they settle at the same time
         * and don't need their own error handling.
         * @param {Error} err
         */
        handleError(err) {
          const { facets } = this;
          facets.helper.updateStatus({ error: err.toString() });
          const { seatRef } = this.state;
          void E.when(E(seatRef).hasExited(), hasExited => {
            if (!hasExited) {
              void E(seatRef).tryExit();
            }
          });
        },
      },

      /** @type {OutcomeWatchers['paymentWatcher']} */
      paymentWatcher: {
        async onFulfilled(payouts) {
          const { state, facets } = this;

          // This will block until all payouts succeed, but user will be updated
          // since each payout will trigger its corresponding purse notifier.
          const amountPKeywordRecord = objectMap(payouts, paymentRef =>
            E.when(paymentRef, payment => state.deposit.receive(payment)),
          );
          const amounts = await deeplyFulfilledObject(amountPKeywordRecord);
          facets.helper.updateStatus({ payouts: amounts });
        },
        /**
         * If promise disconnected, watch again. Or if there's an Error, handle it.
         *
         * @param {Error | import('@agoric/internal/src/upgrade-api.js').UpgradeDisconnection} reason
         * @param {UserSeat} seat
         */
        onRejected(reason, seat) {
          const { facets } = this;
          if (isUpgradeDisconnection(reason)) {
            void watchForPayout(facets, seat);
          } else {
            facets.helper.handleError(reason);
          }
        },
      },

      /** @type {OutcomeWatchers['resultWatcher']} */
      resultWatcher: {
        onFulfilled(result) {
          const { facets } = this;
          facets.helper.publishResult(result);
        },
        /**
         * If promise disconnected, watch again. Or if there's an Error, handle it.
         *
         * @param {Error | import('@agoric/internal/src/upgrade-api.js').UpgradeDisconnection} reason
         * @param {UserSeat} seat
         */
        onRejected(reason, seat) {
          const { facets } = this;
          if (isUpgradeDisconnection(reason)) {
            void watchForOfferResult(facets, seat);
          } else {
            facets.helper.handleError(reason);
          }
        },
      },

      /** @type {OutcomeWatchers['numWantsWatcher']} */
      numWantsWatcher: {
        onFulfilled(numSatisfied) {
          const { facets } = this;

          facets.helper.updateStatus({ numWantsSatisfied: numSatisfied });
        },
        /**
         * If promise disconnected, watch again.
         *
         * Errors are handled by the paymentWatcher because numWantsSatisfied()
         * and getPayouts() settle the same (they await the same promise and
         * then synchronously return a local value).
         *
         * @param {Error | import('@agoric/internal/src/upgrade-api.js').UpgradeDisconnection} reason
         * @param {UserSeat} seat
         */
        onRejected(reason, seat) {
          const { facets } = this;
          if (isUpgradeDisconnection(reason)) {
            void watchForNumWants(facets, seat);
          }
        },
      },
    },
  );
};
harden(prepareOfferWatcher);

/** @typedef {ReturnType<typeof prepareOfferWatcher>} MakeOfferWatcher */
