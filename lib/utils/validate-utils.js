/**
 * Validate a URL string
 * edge cases:
 * - "Handlungselemente: Die Handlung enthält Elemente von Spannung und Aufregung durch die Bodyguard-Thematik.
 *    Die Story beinhaltet ebenso das College leben."
 * @param {*} urlString
 * @returns
 */
function validateURL(urlString) {
  if (typeof urlString !== 'string' || urlString.trim() === '') {
    return false;
  }
  try {
    const parsedUrl = new URL(urlString);

    if (parsedUrl.hostname === 'localhost') {
      return true;
    }

    if (!parsedUrl.hostname) {
      return false;
    }

    const hostnameParts = parsedUrl.hostname.split('.');
    if (hostnameParts.length < 2) {
      return false; // No extension (e.g., "example")
    }

    const lastPart = hostnameParts[hostnameParts.length - 1];
    if (lastPart.length === 0) {
      return false; // Invalid extension (e.g., "example.")
    }

    return ['http:', 'https:', 'wss:'].includes(parsedUrl.protocol);
  } catch (e) {
    return false;
  }
}

module.exports = {
  validateURL
};
