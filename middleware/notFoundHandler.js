'use strict';

/**
 * The reply sent when someone asks for a URL that does not exist.
 *
 * WHY IT EXISTS: The old API returned a particular 404 shape, and clients may rely on it.
 *
 * ROLE IN THE FLOW: Runs after every route has had a chance to handle the request.
 */

function notFoundHandler(req, res) {
  res.status(404).json({ Message: 'No HTTP resource was found that matches the request URI.' });
}

module.exports = notFoundHandler;
