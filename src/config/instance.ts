export const INSTANCE_ID = "design-guide";
export const MAX_ITEM_BYTES = 3_500_000;
/**
 * Browser Run `/crawl` maximums.
 * https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/
 * limit: maximum number of pages to crawl is 100,000.
 * depth: maximum link depth is 100,000. It is not derived from the page limit.
 */
export const BROWSER_CRAWL_LIMIT = 100_000;
export const BROWSER_CRAWL_DEPTH = 100_000;
/** Safety stop for a broken crawl. Reaching it is incomplete, not a successful index. */
export const CRAWL_RUNAWAY_PAGES = 10_000;
export const MIN_SEARCH_SCORE = 0.6;
export const MIN_K = 1;
/** AI Search `max_num_results` ceiling. https://developers.cloudflare.com/ai-search/configuration/retrieval/result-controls/ */
export const MAX_K = 50;
export const RETRIEVAL_CANDIDATES = MAX_K;
