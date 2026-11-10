import type {Page} from '@playwright/test';

export type PresentedFrameSummary = {
  presentedFrames: number,
  presentedDropped: number,
  presentedDroppedPercent: number
};

export function summarizePresentedFrameGaps(timestampsMs: number[], startMs: number, endMs: number): PresentedFrameSummary {
  const frameTimes = timestampsMs.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs)
    .sort((left, right) => left - right);
  const presentedDropped = frameTimes.slice(1).reduce((total, timestamp, index) => {
    const interval = timestamp - frameTimes[index];
    return total + Math.max(0, Math.round(interval / (1_000 / 60)) - 1);
  }, 0);
  const totalFrames = frameTimes.length + presentedDropped;

  return {
    presentedFrames: frameTimes.length,
    presentedDropped,
    presentedDroppedPercent: totalFrames ? presentedDropped / totalFrames * 100 : 0
  };
}

type ScreencastFrameEvent = {
  sessionId: number,
  metadata: {timestamp?: number}
};

export async function startPresentedFrameCapture(page: Page) {
  const session = await page.context().newCDPSession(page);
  const timestampsMs: number[] = [];
  const acknowledgements: Promise<void>[] = [];
  let acknowledgementError: Error | undefined;
  let missingTimestampCount = 0;
  const onFrame = ({sessionId, metadata}: ScreencastFrameEvent): void => {
    if(Number.isFinite(metadata.timestamp)) timestampsMs.push(metadata.timestamp * 1_000);
    else ++missingTimestampCount;
    const acknowledgement: Promise<void> = session.send('Page.screencastFrameAck', {sessionId}).then((): void => {}).catch((error: unknown): void => {
      acknowledgementError = error instanceof Error ? error : new Error(String(error));
    });
    acknowledgements.push(acknowledgement);
  };

  session.on('Page.screencastFrame', onFrame);
  try {
    await session.send('Page.startScreencast', {format: 'jpeg', quality: 0, maxWidth: 1, maxHeight: 1});
  } catch(error) {
    session.off('Page.screencastFrame', onFrame);
    await session.detach();
    throw new Error(`failed to start compositor frame capture: ${String(error)}`);
  }

  return {
    async stop(startMs: number, endMs: number) {
      let stopError: unknown;
      try {
        await session.send('Page.stopScreencast');
      } catch(error) {
        stopError = error;
      } finally {
        session.off('Page.screencastFrame', onFrame);
      }
      try {
        await Promise.all(acknowledgements);
        if(acknowledgementError) throw acknowledgementError;
      } catch(error) {
        stopError = stopError ? new Error(`${String(stopError)}; CDP frame acknowledgement failed: ${String(error)}`) : error;
      }
      try {
        await session.detach();
      } catch(error) {
        stopError = stopError ? new Error(`${String(stopError)}; CDP detach failed: ${String(error)}`) : error;
      }
      if(missingTimestampCount > 0) {
        const timestampError = new Error(`${missingTimestampCount} screencast frame(s) lacked a timestamp`);
        stopError = stopError ? new Error(`${String(stopError)}; ${timestampError.message}`) : timestampError;
      }
      if(stopError) throw new Error(`failed to stop compositor frame capture: ${String(stopError)}`);
      return summarizePresentedFrameGaps(timestampsMs, startMs, endMs);
    }
  };
}
