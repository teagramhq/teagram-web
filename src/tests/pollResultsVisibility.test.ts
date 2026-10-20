import {shouldShowPollResults} from '@components/chat/bubbleParts/pollMessageContent/usePollDerivedProps';

describe('poll results visibility', () => {
  test('keeps unconfirmed server results hidden while a vote is pending', () => {
    expect(shouldShowPollResults({
      hasVoted: true,
      closed: false,
      forceResults: false,
      votePending: true
    })).toBe(false);
  });

  test('shows server results after an accepted vote settles', () => {
    expect(shouldShowPollResults({
      hasVoted: true,
      closed: false,
      forceResults: false,
      votePending: false
    })).toBe(true);
  });

  test('keeps results hidden after a rejected vote with no server vote', () => {
    expect(shouldShowPollResults({
      hasVoted: false,
      closed: false,
      forceResults: false,
      votePending: false
    })).toBe(false);
  });

  test('keeps final results visible when the poll closes during a pending vote', () => {
    expect(shouldShowPollResults({
      hasVoted: false,
      closed: true,
      forceResults: false,
      votePending: true
    })).toBe(true);
  });

  test('keeps results visible when a restriction forces them during a pending vote', () => {
    expect(shouldShowPollResults({
      hasVoted: false,
      closed: false,
      forceResults: true,
      votePending: true
    })).toBe(true);
  });
});
