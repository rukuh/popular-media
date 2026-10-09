const express = require('express')
const flatCache = require('flat-cache')
const Index = require('./index.js')
const AnimeIndex = require('./lib/anime/index.js')
const BooksIndex = require('./lib/books/index.js')
const path = require('path')
const moment = require('moment')

const app = express()

const fs = require('fs')
const os = require('os')

// 1. Initialize Cache
// Saves to 'movie_cache' in CACHE_DIR or '/app/data' folder (or os.tmpdir() when /app/data is unavailable)
const defaultDataDir = fs.existsSync('/app/data') ? path.resolve('/app/data') : os.tmpdir()
const cacheDir = process.env.CACHE_DIR || (process.env.NODE_ENV === 'test' ? os.tmpdir() : defaultDataDir)
const cache = flatCache.load('movie_cache', cacheDir)

app.get('/health', (req, res) => {
  res.status(200).send('Ok');
});

const handleRequest = async function (req, res, listBuilderClass, cachePrefix) {
  let cacheKey = `${cachePrefix}_default`
  let limit = null
  let cachedItem = null
  try {
    // Extract limit and clear_cache from query parameters for key normalization
    const queryParams = { ...req.query };
    limit = queryParams.limit ? parseInt(queryParams.limit, 10) : null;
    const clearCache = queryParams.clear_cache === 'true';

    delete queryParams.limit;
    delete queryParams.clear_cache;

    // Create a unique key based on the normalized user query (excluding limit/clear_cache)
    cacheKey = `${cachePrefix}_${JSON.stringify(queryParams)}`;

    // Check Cache
    const now = Date.now();
    if (clearCache) {
      cache.removeKey(cacheKey);
      cache.save(true);
      console.log(`Cache cleared for key: ${cacheKey}`);
    }
    cachedItem = cache.getKey(cacheKey);

    if (cachedItem && cachedItem.expiry > now) {
      if (Array.isArray(cachedItem.value)) {
        console.log(JSON.stringify({
          level: 'info',
          event: 'cache_hit',
          key: cacheKey,
          timestamp: new Date().toISOString()
        }));
        const results = cachedItem.value;
        const finalResults = (limit && Array.isArray(results)) ? results.slice(0, limit) : results;
        return res.json(finalResults);
      } else {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'invalid_cache_entry',
          key: cacheKey,
          message: 'Cached value is not an array, evicting cache key.',
          timestamp: new Date().toISOString()
        }));
        cache.removeKey(cacheKey);
        cache.save(true);
      }
    } else if (cachedItem && !Array.isArray(cachedItem.value)) {
      cache.removeKey(cacheKey);
      cache.save(true);
    }

    // If not in cache, run evaluation
    console.log(JSON.stringify({
      level: 'info',
      event: 'cache_miss',
      key: cacheKey,
      referer: req.get('referer'),
      clientIp: req.socket.remoteAddress,
      query: req.query,
      timestamp: new Date().toISOString()
    }));

    const listBuilder = new listBuilderClass()
    // Pass original query params so ListBuilder receives them, but evaluate returns full list (if limit is handled in server)
    const evalParams = { ...req.query };
    delete evalParams.limit; // Make sure the builder returns the full list

    const results = await listBuilder.evaluate(evalParams)

    // Save full results to cache only if it is a valid array (Expire in 24 hours)
    if (Array.isArray(results)) {
      cache.setKey(cacheKey, {
        value: results,
        expiry: now + (24 * 60 * 60 * 1000) // 24 Hours
      });
      cache.save(true); // Persist to disk
    } else {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'non_array_evaluation_result',
        key: cacheKey,
        message: 'Evaluation did not return an array; skipping cache storage.',
        timestamp: new Date().toISOString()
      }));
    }

    const finalResults = (limit && Array.isArray(results)) ? results.slice(0, limit) : (results || []);
    return res.json(finalResults)
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'request_failed',
      cacheKey,
      message: error.message,
      timestamp: new Date().toISOString()
    }));

    // Resilience: Fallback to stale cached data if available rather than breaking callers
    if (cachedItem && Array.isArray(cachedItem.value) && cachedItem.value.length > 0) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'serving_stale_cache_on_error',
        key: cacheKey,
        error: error.message,
        timestamp: new Date().toISOString()
      }));
      const results = cachedItem.value;
      const finalResults = (limit && Array.isArray(results)) ? results.slice(0, limit) : results;
      return res.json(finalResults);
    }

    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
  }
}

app.get('/movies', (req, res, next) => handleRequest(req, res, Index, 'movies').catch(next))
app.get('/anime', (req, res, next) => handleRequest(req, res, AnimeIndex, 'anime').catch(next))
app.get('/books', (req, res, next) => handleRequest(req, res, BooksIndex, 'books').catch(next))
app.get('/audiobooks', (req, res, next) => {
  req.query = { list: 'audio-fiction', ...req.query }
  return handleRequest(req, res, BooksIndex, 'books').catch(next)
})

let isSyncing = false

const refreshBooksCache = (books, audioBooks) => {
  if (Array.isArray(books) && books.length > 0) {
    const defaultKey = 'books_{}'
    cache.setKey(defaultKey, {
      value: books,
      expiry: Date.now() + (24 * 60 * 60 * 1000)
    })
    console.log(JSON.stringify({
      level: 'info',
      event: 'books_cache_refreshed',
      key: defaultKey,
      count: books.length,
      timestamp: new Date().toISOString()
    }))
  }
  if (Array.isArray(audioBooks) && audioBooks.length > 0) {
    const audioKey = 'books_{"list":"audio-fiction"}'
    cache.setKey(audioKey, {
      value: audioBooks,
      expiry: Date.now() + (24 * 60 * 60 * 1000)
    })
    console.log(JSON.stringify({
      level: 'info',
      event: 'books_cache_refreshed',
      key: audioKey,
      count: audioBooks.length,
      timestamp: new Date().toISOString()
    }))
  }
  // Clear any parameter-specific book cache entries (e.g. custom lists) except refreshed ones
  cache.keys()
    .filter(k => k.startsWith('books_') && k !== 'books_{}' && k !== 'books_{"list":"audio-fiction"}')
    .forEach(k => cache.removeKey(k))
  cache.save(true)
}

const handleBooksSync = async (req, res) => {
  console.log(JSON.stringify({
    level: 'info',
    event: 'books_sync_triggered',
    method: req.method,
    clientIp: req.socket.remoteAddress,
    timestamp: new Date().toISOString()
  }))

  if (isSyncing) {
    return res.status(409).json({
      status: 'in_progress',
      message: 'A books sync is already in progress.'
    })
  }

  isSyncing = true
  try {
    const booksIndex = new BooksIndex()
    const result = await booksIndex.sync()
    if (result) {
      const fictionBooks = result.fiction ? result.fiction.books : result.books
      const audioBooks = result.audio ? result.audio.books : null
      refreshBooksCache(fictionBooks, audioBooks)
    }
    res.json(result)
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'books_sync_failed',
      message: error.message,
      timestamp: new Date().toISOString()
    }))
    res.status(500).json({ error: 'Sync Failed', message: error.message })
  } finally {
    isSyncing = false
  }
}

app.post('/books/sync', handleBooksSync)

// Automated Weekly Sync for Books
// Run every Wednesday at 7:00 PM
const runWeeklySync = async () => {
  const now = moment();
  // Check if it's Wednesday (day 3) and the hour is 19 (7 PM)
  if (now.day() === 3 && now.hour() === 19) {
    if (isSyncing) {
      console.warn('Automated weekly book sync skipped: another sync is already in progress.');
      return;
    }
    console.log('Triggering automated weekly book sync...');
    isSyncing = true;
    try {
      const booksIndex = new BooksIndex();
      const result = await booksIndex.sync();
      if (result) {
        const fictionBooks = result.fiction ? result.fiction.books : result.books;
        const audioBooks = result.audio ? result.audio.books : null;
        refreshBooksCache(fictionBooks, audioBooks);
      }
      console.log('Automated weekly book sync completed successfully.');
    } catch (err) {
      console.error('Automated weekly book sync failed:', err.message);
    } finally {
      isSyncing = false;
    }
  }
};

let server
if (require.main === module) {
  // Check every hour
  setInterval(runWeeklySync, 60 * 60 * 1000);
  server = app.listen(3000, () => console.log('Server running on 3000'))
}

let isShuttingDown = false
const gracefulShutdown = (signal) => {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`Received ${signal}, initiating graceful shutdown...`)
  try {
    cache.save(true)
  } catch (err) {
    console.error('Failed to save cache during shutdown:', err.message)
  }

  if (server) {
    server.close(() => {
      console.log('HTTP server closed.')
      process.exit(0)
    })
  } else {
    process.exit(0)
  }

  // Force exit if connections do not close in time
  setTimeout(() => {
    console.warn('Forcefully exiting after shutdown timeout.')
    process.exit(0)
  }, 5000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

module.exports = {
  app,
  handleRequest,
  cache,
  refreshBooksCache
}
