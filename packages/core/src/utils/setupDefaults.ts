/**
 * Default `setupBudgetMs`: the wall time each keyword-index quantum (one per
 * `setup()` and per no-arg `syncSearchIndex()`) may spend on drain/rebuild
 * chunks, checked between chunk transactions (spec #280 Config surface).
 */
export const DEFAULT_SETUP_BUDGET_MS = 1500;
