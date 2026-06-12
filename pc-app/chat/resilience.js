/** Count consecutive failures; trip after threshold. Call ok() on success. */
function createStrikeCounter(threshold, onTripped) {
  let strikes = 0;
  return {
    ok() {
      strikes = 0;
    },
    fail() {
      strikes += 1;
      if (strikes >= threshold) {
        strikes = 0;
        onTripped();
        return true;
      }
      return false;
    },
    get count() {
      return strikes;
    }
  };
}

module.exports = { createStrikeCounter };
