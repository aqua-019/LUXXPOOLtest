/**
 * LUXXPOOL — Variable Difficulty Manager
 * Dynamically adjusts mining difficulty per-client to maintain
 * a target share submission rate.
 */

class VarDiffManager {
  /**
   * @param {object} config
   * @param {number} config.min - Minimum difficulty
   * @param {number} config.max - Maximum difficulty
   * @param {number} config.targetTime - Target seconds between shares
   * @param {number} config.retargetTime - Seconds between difficulty adjustments
   */
  constructor(config = {}) {
    this.minDiff      = config.min || 64;
    this.maxDiff      = config.max || 65536;
    this.targetTime   = config.targetTime || 15;
    this.retargetTime = config.retargetTime || 90;

    this.shareTimes = [];
    this.lastRetarget = Date.now();
    this.lastShareTime = null;
  }

  /**
   * Record a share submission timestamp
   * @returns {number|null} New difficulty if adjustment needed, null otherwise
   */
  recordShare() {
    const now = Date.now();

    if (this.lastShareTime !== null) {
      const timeSince = (now - this.lastShareTime) / 1000;
      this.shareTimes.push(timeSince);
    }
    this.lastShareTime = now;

    // Check if it's time to retarget
    const timeSinceRetarget = (now - this.lastRetarget) / 1000;
    if (timeSinceRetarget < this.retargetTime || this.shareTimes.length < 3) {
      return null;
    }

    return this._calculateNewDifficulty();
  }

  /**
   * Calculate new difficulty based on recent share times
   * @returns {number} New difficulty
   */
  _calculateNewDifficulty() {
    // Use only recent share times
    const recentTimes = this.shareTimes.slice(-20);
    const avgTime = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;

    // Calculate adjustment ratio
    const ratio = this.targetTime / avgTime;

    // Clamp adjustment to 4x up or 0.25x down per retarget
    const clampedRatio = Math.max(0.25, Math.min(4, ratio));

    // Reset state
    this.shareTimes = [];
    this.lastRetarget = Date.now();

    return clampedRatio;
  }

  /**
   * Apply adjustment ratio to current difficulty
   * @param {number} currentDiff
   * @param {number} ratio - From _calculateNewDifficulty
   * @returns {number} Clamped new difficulty
   */
  applyAdjustment(currentDiff, ratio) {
    if (ratio === null) return currentDiff;

    let newDiff = Math.round(currentDiff * ratio);

    // Clamp to bounds
    newDiff = Math.max(this.minDiff, Math.min(this.maxDiff, newDiff));

    // Snap to powers of 2 for clean difficulty values
    newDiff = this._snapToPowerOf2(newDiff);

    return newDiff;
  }

  /**
   * Snap to nearest power of 2
   */
  _snapToPowerOf2(n) {
    const log2 = Math.log2(n);
    const lower = Math.pow(2, Math.floor(log2));
    const upper = Math.pow(2, Math.ceil(log2));
    return (n - lower < upper - n) ? lower : upper;
  }
}

module.exports = VarDiffManager;
