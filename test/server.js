/* eslint-env mocha */
const expect = require('must')
const { handleRequest, cache } = require('../server')

describe('server - handleRequest cache and slice safety', function () {
  const dummyKeyPrefix = 'test_books'

  beforeEach(function () {
    // Clean up dummy cache keys
    const keys = cache.keys().filter(k => k.startsWith(dummyKeyPrefix))
    keys.forEach(k => cache.removeKey(k))
  })

  afterEach(function () {
    const keys = cache.keys().filter(k => k.startsWith(dummyKeyPrefix))
    keys.forEach(k => cache.removeKey(k))
  })

  it('should safely evict non-array cached items and not throw results.slice is not a function', async function () {
    const cacheKey = `${dummyKeyPrefix}_{}`
    // Pre-populate with a non-array object (the exact trigger of the crash)
    cache.setKey(cacheKey, {
      value: { nyt_count: 15, hardcover: { status: 'success' }, status: 'success' },
      expiry: Date.now() + 100000
    })

    const req = {
      query: { limit: '5' },
      get: () => '',
      socket: { remoteAddress: '127.0.0.1' }
    }

    let sentStatus = null
    let sentJson = null
    const res = {
      status: (code) => { sentStatus = code; return res },
      json: (data) => { sentJson = data; return res },
      headersSent: false
    }

    class MockListBuilder {
      async evaluate () {
        return [
          { title: 'Book 1' },
          { title: 'Book 2' },
          { title: 'Book 3' },
          { title: 'Book 4' },
          { title: 'Book 5' },
          { title: 'Book 6' }
        ]
      }
    }

    await handleRequest(req, res, MockListBuilder, dummyKeyPrefix)

    expect(sentStatus).to.be.null()
    expect(Array.isArray(sentJson)).to.be.true()
    expect(sentJson.length).to.equal(5)
    expect(sentJson[0].title).to.equal('Book 1')

    // Verify cache now holds the new array
    const cachedItem = cache.getKey(cacheKey)
    expect(Array.isArray(cachedItem.value)).to.be.true()
  })

  it('should slice array cache hits when limit is provided', async function () {
    const cacheKey = `${dummyKeyPrefix}_{}`
    cache.setKey(cacheKey, {
      value: [{ title: 'Item 1' }, { title: 'Item 2' }, { title: 'Item 3' }],
      expiry: Date.now() + 100000
    })

    const req = {
      query: { limit: '2' },
      get: () => '',
      socket: { remoteAddress: '127.0.0.1' }
    }

    let sentJson = null
    const res = {
      status: () => res,
      json: (data) => { sentJson = data; return res },
      headersSent: false
    }

    class MockListBuilder {
      async evaluate () {
        throw new Error('Should not be called on cache hit')
      }
    }

    await handleRequest(req, res, MockListBuilder, dummyKeyPrefix)

    expect(Array.isArray(sentJson)).to.be.true()
    expect(sentJson.length).to.equal(2)
    expect(sentJson[0].title).to.equal('Item 1')
    expect(sentJson[1].title).to.equal('Item 2')
  })

  it('should catch errors from listBuilder and return 500 without unhandled rejection', async function () {
    const req = {
      query: {},
      get: () => '',
      socket: { remoteAddress: '127.0.0.1' }
    }

    let sentStatus = null
    let sentJson = null
    const res = {
      status: (code) => { sentStatus = code; return res },
      json: (data) => { sentJson = data; return res },
      headersSent: false
    }

    class FailingListBuilder {
      async evaluate () {
        throw new Error('API failure')
      }
    }

    await handleRequest(req, res, FailingListBuilder, dummyKeyPrefix)

    expect(sentStatus).to.equal(500)
    expect(sentJson.error).to.equal('Internal Server Error')
    expect(sentJson.message).to.equal('API failure')
  })

  it('should not cache non-array evaluation results', async function () {
    const cacheKey = `${dummyKeyPrefix}_{}`
    const req = {
      query: {},
      get: () => '',
      socket: { remoteAddress: '127.0.0.1' }
    }

    let sentJson = null
    const res = {
      status: () => res,
      json: (data) => { sentJson = data; return res },
      headersSent: false
    }

    class ObjectListBuilder {
      async evaluate () {
        return { count: 10, status: 'ok' }
      }
    }

    await handleRequest(req, res, ObjectListBuilder, dummyKeyPrefix)

    expect(sentJson).to.eql({ count: 10, status: 'ok' })
    const cached = cache.getKey(cacheKey)
    expect(cached).to.be.undefined()
  })

  it('should refresh books cache and invalidate custom list keys', function () {
    const freshBooks = [{ title: 'New NYT #1 Book', author: 'Author' }]
    cache.setKey('books_{"list":"custom"}', { value: [{ title: 'Old' }], expiry: Date.now() + 10000 })

    const { refreshBooksCache } = require('../server')
    refreshBooksCache(freshBooks)

    const defaultCached = cache.getKey('books_{}')
    expect(defaultCached).to.not.be.undefined()
    expect(defaultCached.value).to.eql(freshBooks)

    // Parameter-specific variant should be evicted
    const customCached = cache.getKey('books_{"list":"custom"}')
    expect(customCached).to.be.undefined()
  })

  it('should serve stale cache when listBuilder fails on an expired cache entry', async function () {
    const cacheKey = `${dummyKeyPrefix}_{}`
    // Seed expired cache
    cache.setKey(cacheKey, {
      value: [{ title: 'Stale Item 1' }, { title: 'Stale Item 2' }],
      expiry: Date.now() - 5000 // Expired
    })

    const req = {
      query: { limit: '1' },
      get: () => '',
      socket: { remoteAddress: '127.0.0.1' }
    }

    let sentJson = null
    const res = {
      status: () => res,
      json: (data) => { sentJson = data; return res },
      headersSent: false
    }

    class FlakyBuilder {
      async evaluate () {
        throw new Error('Upstream 503 Outage')
      }
    }

    await handleRequest(req, res, FlakyBuilder, dummyKeyPrefix)

    expect(Array.isArray(sentJson)).to.be.true()
    expect(sentJson.length).to.equal(1)
    expect(sentJson[0].title).to.equal('Stale Item 1')
  })
})
