/**
 * The three lines of axios that `skyhelper-networth` actually uses, on top of `fetch`.
 *
 * Not because axios fails on Workers - it has a fetch adapter and would probably work -
 * but because it picks that adapter by sniffing the environment, and under
 * `nodejs_compat` a Worker looks enough like Node for the sniff to be a coin toss that
 * is only settled at runtime, on a deploy. It also drags in around 60 KiB of transport
 * code to make two GET requests, both of which `fetch` already makes natively.
 *
 * The package calls `axios.get(url, { timeout })` in two places and reads
 * `error.response.status` and `axios.isAxiosError(error)` when one fails, so that is
 * what this provides. Anything else it might grow a use for is missing on purpose.
 */

class AxiosError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'AxiosError';
    this.isAxiosError = true;
    this.response = response;
  }
}

/**
 * axios rejects on a 4xx or 5xx where fetch resolves, and the retry logic in
 * skyhelper-networth is written against the rejection, so the status is turned back into
 * a throw here. `timeout` is honoured through AbortSignal: without it a hung request
 * would hold the whole networth call open until the Worker's own limit killed it.
 */
async function get(url, config = {}) {
  const res = await fetch(url, {
    signal: config.timeout ? AbortSignal.timeout(config.timeout) : undefined,
    headers: config.headers,
  });

  if (!res.ok) {
    throw new AxiosError('Request failed with status code ' + res.status, {
      status: res.status,
      statusText: res.statusText,
    });
  }

  return { data: await res.json(), status: res.status };
}

const isAxiosError = (error) => !!error && error.isAxiosError === true;

export { get, isAxiosError, AxiosError };
export default { get, isAxiosError, AxiosError };
