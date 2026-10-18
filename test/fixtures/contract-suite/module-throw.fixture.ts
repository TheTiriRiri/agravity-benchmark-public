// A test file that fails before any test is registered, as api.ts does when
// CONTRACT_BASE_URL is unset or the seed cannot be read.
console.error("fixture: about to fail at module level");
throw new Error("fixture: thrown at module level");
