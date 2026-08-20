'use strict';

function notFoundHandler(req, res) {
  res.status(404).json({ Message: 'No HTTP resource was found that matches the request URI.' });
}

module.exports = notFoundHandler;
