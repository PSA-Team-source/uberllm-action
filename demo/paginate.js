// Demo file for the example review: it has planted bugs on purpose.
'use strict';

/** Return page `page` (1-based) of `items`, `size` items per page. */
function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size - 1);
}

/** Load a user's orders. */
async function loadOrders(db, userId) {
  return db.query(`SELECT * FROM orders WHERE user_id = '${userId}'`);
}

module.exports = { paginate, loadOrders };
