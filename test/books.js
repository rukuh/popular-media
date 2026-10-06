/* eslint-env mocha */
const expect = require('must')
const axios = require('axios')
const hardcover = require('../lib/books/hardcover')

describe('books - hardcover client', function () {
  this.timeout(10000)

  let originalPost

  beforeEach(function () {
    originalPost = axios.post
  })

  afterEach(function () {
    axios.post = originalPost
  })

  it('should return data on successful GraphQL response', async function () {
    axios.post = async () => ({
      data: {
        data: { lists: [{ id: 123, slug: 'trending' }] }
      }
    })

    const res = await hardcover.graphqlRequest('query { lists { id } }')
    expect(res).to.be.an.object()
    expect(res.lists[0].id).to.equal(123)
  })

  it('should throw immediately if GraphQL response contains errors array', async function () {
    axios.post = async () => ({
      data: {
        errors: [{ message: 'Field not found' }]
      }
    })

    let caught = null
    try {
      await hardcover.graphqlRequest('query { invalid }')
    } catch (err) {
      caught = err
    }
    expect(caught).to.not.be.null()
    expect(caught.message).to.contain('Field not found')
  })

  it('should retry and succeed after receiving HTTP 429 rate limit', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        const err = new Error('Request failed with status code 429')
        err.response = {
          status: 429,
          headers: { 'retry-after': '1' }
        }
        throw err
      }
      return {
        data: {
          data: { status: 'recovered_from_rate_limit' }
        }
      }
    }

    const res = await hardcover.graphqlRequest('query { test }', {}, 2, 50)
    expect(callCount).to.equal(2)
    expect(res.status).to.equal('recovered_from_rate_limit')
  })

  it('should handle non-integer HTTP-date retry-after header without NaN delay', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        const err = new Error('Rate limit')
        err.response = {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }
        }
        throw err
      }
      return {
        data: {
          data: { success: true }
        }
      }
    }

    const res = await hardcover.graphqlRequest('query { test }', {}, 2, 50)
    expect(callCount).to.equal(2)
    expect(res.success).to.be.true()
  })

  it('should retry on transient 502/503 errors and socket drops', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        const err = new Error('Bad Gateway')
        err.response = { status: 502, headers: {} }
        throw err
      }
      if (callCount === 2) {
        const err = new Error('socket hang up')
        err.code = 'ECONNRESET'
        throw err
      }
      return {
        data: {
          data: { recovered: true }
        }
      }
    }

    const res = await hardcover.graphqlRequest('query { test }', {}, 3, 50)
    expect(callCount).to.equal(3)
    expect(res.recovered).to.be.true()
  })

  it('should throw immediately without retrying on 400 Bad Request or 401 Unauthorized', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      const err = new Error('Unauthorized')
      err.response = { status: 401, headers: {} }
      throw err
    }

    let caught = null
    try {
      await hardcover.graphqlRequest('query { test }', {}, 3, 50)
    } catch (err) {
      caught = err
    }

    expect(caught).to.not.be.null()
    expect(callCount).to.equal(1) // No retries for 401
  })

  it('should throw immediately without retrying on 403 insufficient_scope', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      const err = new Error('Forbidden')
      err.response = {
        status: 403,
        headers: { 'www-authenticate': 'Bearer realm="hardcover", error="insufficient_scope"' },
        data: { error: 'insufficient_scope', error_description: 'Missing scopes: read:catalog' }
      }
      throw err
    }

    let caught = null
    try {
      await hardcover.graphqlRequest('query { test }', {}, 3, 50)
    } catch (err) {
      caught = err
    }

    expect(caught).to.not.be.null()
    expect(caught.isInsufficientScope).to.be.true()
    expect(callCount).to.equal(1) // No retries for insufficient_scope
  })

  it('should retry and succeed after receiving HTTP 403 rate limit / forbidden response', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        const err = new Error('Request failed with status code 403')
        err.response = { status: 403, headers: {} }
        throw err
      }
      return {
        data: {
          data: { status: 'recovered_from_403' }
        }
      }
    }

    const res = await hardcover.graphqlRequest('query { test }', {}, 2, 50)
    expect(callCount).to.equal(2)
    expect(res.status).to.equal('recovered_from_403')
  })

  it('should retry through consecutive 429 and 403 rate limit responses', async function () {
    let callCount = 0
    axios.post = async () => {
      callCount++
      if (callCount === 1) {
        const err = new Error('Request failed with status code 429')
        err.response = { status: 429, headers: { 'retry-after': '1' } }
        throw err
      }
      if (callCount === 2) {
        const err = new Error('Request failed with status code 403')
        err.response = { status: 403, headers: {} }
        throw err
      }
      return {
        data: {
          data: { status: 'recovered_from_consecutive_rate_limits' }
        }
      }
    }

    const res = await hardcover.graphqlRequest('query { test }', {}, 3, 50)
    expect(callCount).to.equal(3)
    expect(res.status).to.equal('recovered_from_consecutive_rate_limits')
  })
})

describe('books - chaptarr client', function () {
  const chaptarr = require('../lib/books/chaptarr')

  it('should lookup a book and return candidate', async function () {
    const mockClient = {
      get: async (url, config) => {
        expect(url).to.equal('/book/lookup')
        expect(config.params.term).to.equal('isbn:9780593135204')
        return {
          data: [
            { id: 10, title: 'Project Hail Mary', foreignBookId: 'gr:79106958' }
          ]
        }
      }
    }

    const book = await chaptarr.lookupBook(mockClient, 'isbn:9780593135204')
    expect(book).to.not.be.null()
    expect(book.title).to.equal('Project Hail Mary')
  })

  it('should return null when lookup finds no books or errors', async function () {
    const mockClientEmpty = {
      get: async () => ({ data: [] })
    }
    const resEmpty = await chaptarr.lookupBook(mockClientEmpty, 'unknown')
    expect(resEmpty).to.be.null()

    const mockClientError = {
      get: async () => {
        throw new Error('Network timeout')
      }
    }
    const resError = await chaptarr.lookupBook(mockClientError, 'error')
    expect(resError).to.be.null()
  })

  it('should post book with correct ebook payload to /book', async function () {
    let postedPayload = null
    const mockClient = {
      post: async (url, payload) => {
        expect(url).to.equal('/book')
        postedPayload = payload
        return {
          data: {
            id: 99,
            title: payload.title
          }
        }
      }
    }

    const candidate = {
      title: 'The Women',
      author: { authorName: 'Kristin Hannah' }
    }

    mockClient.put = async (url, payload) => ({ data: { id: 99, ...payload } })
    mockClient.post = async (url, payload) => {
      if (url === '/command') return { data: { status: 'queued' } }
      expect(url).to.equal('/book')
      postedPayload = payload
      return {
        data: {
          id: 99,
          title: payload.title,
          monitored: true,
          ebookMonitored: true
        }
      }
    }

    const added = await chaptarr.addBook(mockClient, candidate)
    expect(added.id).to.equal(99)
    expect(postedPayload.mediaType).to.equal('ebook')
    expect(postedPayload.ebookMonitored).to.be.true()
    expect(postedPayload.monitored).to.be.true()
    expect(postedPayload.audiobookMonitored).to.be.false()
    expect(postedPayload.author.ebookRootFolderPath).to.equal('/media/Books')
    expect(postedPayload.author.ebookQualityProfileId).to.equal(1)
    expect(postedPayload.author.ebookMetadataProfileId).to.equal(2)
    expect(postedPayload.author.ebookMonitorExisting).to.equal(2)
    expect(postedPayload.author.ebookMonitorFuture).to.be.false()
    expect(postedPayload.addOptions.searchForNewBook).to.be.true()
  })

  it('should ensure author has future and existing book monitoring disabled', async function () {
    let authorUpdated = false
    const mockClient = {
      get: async (url) => {
        expect(url).to.equal('/author/123')
        return {
          data: {
            id: 123,
            authorName: 'Test Author',
            ebookMonitorFuture: true,
            ebookMonitorExisting: 0
          }
        }
      },
      put: async (url, payload) => {
        expect(url).to.equal('/author/123')
        expect(payload.ebookMonitorFuture).to.be.false()
        expect(payload.ebookMonitorExisting).to.equal(2)
        authorUpdated = true
        return { data: payload }
      }
    }

    await chaptarr.ensureAuthorUnmonitored(mockClient, 123)
    expect(authorUpdated).to.be.true()
  })

  it('should skip updating author if already configured with monitoring disabled', async function () {
    let putCalled = false
    const mockClient = {
      get: async () => ({
        data: {
          id: 123,
          ebookMonitorFuture: false,
          ebookMonitorExisting: 2
        }
      }),
      put: async () => {
        putCalled = true
      }
    }

    await chaptarr.ensureAuthorUnmonitored(mockClient, 123)
    expect(putCalled).to.be.false()
  })

  it('should sync books list resolving by ISBN first then title', async function () {
    process.env.CHAPTARR_API_KEY = 'test_key'
    const nytBooks = [
      { title: 'Book 1', author: 'Author 1', isbn13: '1111111111111' },
      { title: 'Book 2', author: 'Author 2', isbn13: null, isbn10: null }
    ]

    const lookups = []
    const posts = []

    const origGetClient = chaptarr.getClient
    chaptarr.getClient = () => ({
      get: async (url, config) => {
        lookups.push(config.params.term)
        return {
          data: [{ title: config.params.term, author: { authorName: 'Author' } }]
        }
      },
      post: async (url, payload) => {
        posts.push(payload.title)
        return { data: { id: 100 + posts.length, title: payload.title, monitored: true, ebookMonitored: true } }
      },
      put: async (url, payload) => ({ data: payload })
    })

    try {
      const res = await chaptarr.syncBooks(nytBooks)
      expect(res.status).to.equal('success')
      expect(res.matched_count).to.equal(2)
      expect(res.synced_count).to.equal(2)
      expect(lookups[0]).to.equal('isbn:1111111111111')
      expect(lookups[1]).to.equal('Book 2 Author 2')
    } finally {
      chaptarr.getClient = origGetClient
    }
  })
})

describe('books - BooksIndex', function () {
  const BooksIndex = require('../lib/books/index')
  const nyt = require('../lib/books/nyt')
  const chaptarr = require('../lib/books/chaptarr')

  let origGetBestSellers
  let origToken
  let origListId

  beforeEach(function () {
    origGetBestSellers = nyt.getBestSellers
    origToken = process.env.HARDCOVER_API_TOKEN
    origListId = process.env.HARDCOVER_LIST_ID
    process.env.HARDCOVER_API_TOKEN = 'mock_hc_token'
    process.env.HARDCOVER_LIST_ID = 'mock_list_slug'
  })

  afterEach(function () {
    nyt.getBestSellers = origGetBestSellers
    process.env.HARDCOVER_API_TOKEN = origToken
    process.env.HARDCOVER_LIST_ID = origListId
  })

  it('should evaluate books using NYT best sellers list', async function () {
    const mockBooks = [
      { title: 'The Women', author: 'Kristin Hannah' },
      { title: 'Fourth Wing', author: 'Rebecca Yarros' }
    ]
    nyt.getBestSellers = async (list) => {
      expect(list).to.equal('combined-print-and-e-book-fiction')
      return mockBooks
    }

    const booksIndex = new BooksIndex()
    const result = await booksIndex.evaluate()
    expect(result).to.eql(mockBooks)
  })

  it('should allow custom list in evaluate', async function () {
    nyt.getBestSellers = async (list) => {
      expect(list).to.equal('hardcover-fiction')
      return [{ title: 'Custom Book', author: 'Author' }]
    }

    const booksIndex = new BooksIndex()
    const result = await booksIndex.evaluate({ list: 'hardcover-fiction' })
    expect(result).to.have.length(1)
    expect(result[0].title).to.equal('Custom Book')
  })

  it('should run sync successfully orchestrating NYT, Hardcover, and Chaptarr', async function () {
    const mockBooks = [{ title: 'Book 1', author: 'Author 1' }]
    nyt.getBestSellers = async () => mockBooks

    const booksIndex = new BooksIndex()
    booksIndex.syncHardcover = async (books) => {
      expect(books).to.eql(mockBooks)
      return { status: 'success', matched_count: 1 }
    }

    const origSyncBooks = chaptarr.syncBooks
    chaptarr.syncBooks = async (books) => {
      expect(books).to.eql(mockBooks)
      return { status: 'success', matched_count: 1, synced_count: 1 }
    }

    try {
      const result = await booksIndex.sync()
      expect(result.status).to.equal('success')
      expect(result.nyt_count).to.equal(1)
      expect(result.books).to.eql(mockBooks)
      expect(result.hardcover.status).to.equal('success')
      expect(result.chaptarr.status).to.equal('success')
    } finally {
      chaptarr.syncBooks = origSyncBooks
    }
  })

  it('should abort and return skipped status when Hardcover token encounters insufficient_scope without processing remaining books', async function () {
    const origGetList = hardcover.getListIdAndBooks
    const origGetISBN = hardcover.getBookByISBN
    const origReplace = hardcover.replaceBooksInList

    let isbnCalls = 0
    let replaceCalled = false

    hardcover.getListIdAndBooks = async () => ({ id: 555, listBooks: [{ id: 1 }, { id: 2 }] })
    hardcover.getBookByISBN = async () => {
      isbnCalls++
      const err = new Error('Hardcover API token lacks required scope: Missing scopes: read:catalog')
      err.isInsufficientScope = true
      throw err
    }
    hardcover.replaceBooksInList = async () => {
      replaceCalled = true
      return { status: 'success' }
    }

    try {
      const booksIndex = new BooksIndex()
      const nytBooks = [
        { title: 'Book 1', author: 'Author 1', isbn13: '111' },
        { title: 'Book 2', author: 'Author 2', isbn13: '222' }
      ]
      const res = await booksIndex.syncHardcover(nytBooks)
      expect(res.status).to.equal('skipped')
      expect(res.reason).to.equal('insufficient_scope')
      expect(isbnCalls).to.equal(1)
      expect(replaceCalled).to.be.false()
    } finally {
      hardcover.getListIdAndBooks = origGetList
      hardcover.getBookByISBN = origGetISBN
      hardcover.replaceBooksInList = origReplace
    }
  })

  it('should abort Hardcover list replacement if zero books matched from non-empty NYT list (safety threshold safeguard)', async function () {
    const origGetList = hardcover.getListIdAndBooks
    const origGetISBN = hardcover.getBookByISBN
    const origSearch = hardcover.searchBookByTitleAuthor
    const origReplace = hardcover.replaceBooksInList

    let replaceCalled = false

    hardcover.getListIdAndBooks = async () => ({ id: 555, listBooks: [{ id: 1 }, { id: 2 }] })
    hardcover.getBookByISBN = async () => null
    hardcover.searchBookByTitleAuthor = async () => null
    hardcover.replaceBooksInList = async () => {
      replaceCalled = true
      return { status: 'success' }
    }

    try {
      const booksIndex = new BooksIndex()
      const nytBooks = [
        { title: 'Book 1', author: 'Author 1', isbn13: '111' }
      ]
      const res = await booksIndex.syncHardcover(nytBooks)
      expect(res.status).to.equal('skipped')
      expect(res.reason).to.equal('zero_matches_safety_abort')
      expect(replaceCalled).to.be.false()
    } finally {
      hardcover.getListIdAndBooks = origGetList
      hardcover.getBookByISBN = origGetISBN
      hardcover.searchBookByTitleAuthor = origSearch
      hardcover.replaceBooksInList = origReplace
    }
  })
})
