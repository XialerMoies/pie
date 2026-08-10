export function firstTimingAtOrAfter(result, { contextId, event, at }) {
  return result.timings.find((entry) => (
    entry.contextId === contextId
    && entry.event === event
    && entry.at >= at
  ));
}
