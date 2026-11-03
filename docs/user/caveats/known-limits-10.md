# Known limits, part ten

Limits of an attached Chrome
([`browser.cdp`](../how-to/browser-login.md#attaching-your-own-chrome)).
[Part four](known-limits-04.md#the-browser) covers the rest of the browser, and the
[first part](known-limits.md) lists the other limits.

## The attached Chrome

- Buckle tells attached Chromes apart by host and port and resolves no name, so two names of one
  machine, such as a DNS name and its address, count as two Chromes, both for which workspace holds
  it and for its hold: a value filled through one name is not masked in a call through the other.
- `buckle browser close` drops an attached Chrome's hold only once its host and port refuse a
  connection, so a remote browser service whose port stays open keeps its hold; put the file back to
  keep calls running.
- A refused connection does not prove Chrome closed, as a proxy or forwarded port in front of it can
  stop while Chrome keeps its pages, and Buckle never closes your Chrome itself, so close every window
  of it before you run the command.
