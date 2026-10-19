import { t } from '../shared/i18n.mjs';

// WeCom closes a streaming card 10 minutes after its FIRST frame; refreshes do
// not extend the window (verified against the provider: errcode 846608
// "stream message update expired (>10 minutes), cannot update"). A long or
// silent turn therefore outlives its card, and every later frame plus the
// final finish are rejected — the reply is lost.
//
// The supervisor keeps a turn deliverable by rotating cards before the wall:
// each rotation finishes the current card with a pointer note and opens a
// fresh stream that carries the same preview content. It also probes silent
// stretches (no frames to send) so the card stays informative, and rebuilds
// immediately after back-to-back rejected updates in case a card dies early.
export function createWecomStreamSupervisor({
  client,
  frame,
  chatId,
  generateStreamId,
  previewText = () => '',
  logger = console,
  rotateAfterMs = 8 * 60 * 1000 + 30 * 1000,
  silentProbeMs = 2 * 60 * 1000,
  tickMs = 60 * 1000,
}) {
  if (!client || typeof client.replyStream !== 'function') {
    throw new TypeError('createWecomStreamSupervisor requires a client with replyStream');
  }
  if (typeof generateStreamId !== 'function') {
    throw new TypeError('createWecomStreamSupervisor requires a generateStreamId function');
  }
  let currentStreamId = null;
  let cardStartedAt = Date.now();
  let lastFrameAt = Date.now();
  let segmentNo = 1;
  let alive = true;
  let rejects = 0;

  // The SDK rejects send promises with the raw ack frame, which carries
  // errcode/errmsg but no .message; wrap it so every caller sees an Error.
  const normalize = (error) => {
    if (error instanceof Error) return error;
    const errcode = error?.errcode ?? error?.body?.errcode ?? error?.header?.errcode;
    const wrapped = new Error(
      `${error?.errmsg ?? error?.body?.errmsg ?? 'wecom stream update rejected'} (errcode=${errcode ?? 'unknown'})`,
    );
    if (errcode !== undefined) wrapped.errcode = Number(errcode);
    if (typeof error?.errmsg === 'string') wrapped.errmsg = error.errmsg;
    return wrapped;
  };

  const reply = (streamId, text, finish) => client.replyStream(frame, streamId, text, finish);

  const rotate = async (headText) => {
    const closedSegment = segmentNo;
    segmentNo += 1;
    if (currentStreamId) {
      await reply(
        currentStreamId,
        t('▣ 第 {segment} 段 · 任务仍在进行，继续见下一条 ↓', { segment: closedSegment }),
        true,
      ).catch(() => undefined);
    }
    const nextId = generateStreamId();
    try {
      await reply(nextId, headText || t('继续执行中…'), false);
      currentStreamId = nextId;
      cardStartedAt = Date.now();
      lastFrameAt = Date.now();
      rejects = 0;
      alive = true;
      logger.warn?.(`[dsh-im:wecom] stream card rotated to segment ${segmentNo} for chat ${chatId}`);
    } catch (error) {
      // Without a live card the final reply must go through an active message
      // instead; keep the supervisor alive=false so callers skip the stream.
      alive = false;
      logger.warn?.(
        '[dsh-im:wecom] stream rotation failed; final delivery will use an active message:',
        normalize(error),
      );
    }
    return currentStreamId;
  };

  const send = async (preview) => {
    if (!alive || !currentStreamId) return;
    try {
      await client.replyStreamNonBlocking(frame, currentStreamId, preview, false);
      rejects = 0;
      lastFrameAt = Date.now();
    } catch (error) {
      const normalized = normalize(error);
      if (Number.isFinite(normalized.errcode) && normalized.errcode !== 0) {
        rejects += 1;
        logger.warn?.(`[dsh-im:wecom] stream update rejected (${rejects}x): ${normalized.message}`);
        if (rejects >= 2) {
          alive = false;
          await rotate(preview);
        }
      } else {
        logger.warn?.('[dsh-im:wecom] stream update failed:', normalized.message);
      }
    }
  };

  const timer = setInterval(() => {
    Promise.resolve().then(async () => {
      if (!alive || !currentStreamId) return;
      if (Date.now() - cardStartedAt >= rotateAfterMs) {
        await rotate(previewText());
      } else if (Date.now() - lastFrameAt >= silentProbeMs) {
        await send(previewText() || t('仍在执行中…'));
      }
    }).catch(() => undefined);
  }, tickMs);

  return {
    start(streamId) { currentStreamId = streamId; },
    currentId: () => currentStreamId,
    isAlive: () => alive,
    async progress(preview) {
      if (!alive || !currentStreamId || !preview) return;
      if (Date.now() - cardStartedAt >= rotateAfterMs) await rotate(preview);
      else await send(preview);
    },
    async finishStream(text) {
      if (!alive || !currentStreamId) throw new Error('wecom stream unavailable');
      return reply(currentStreamId, text, true);
    },
    stop() { clearInterval(timer); },
  };
}
