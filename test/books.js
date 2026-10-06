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

    const added = await chaptarr.addBook(mockClient, candidate)
    expect(added.id).to.equal(99)
    expect(postedPayload.mediaType).to.equal('ebook')
    expect(postedPayload.ebookMonitored).to.be.true()
    expect(postedPayload.monitored).to.be.true()
    expect(postedPayload.author.ebookRootFolderPath).to.equal('/media/Books')
    expect(postedPayload.author.ebookQualityProfileId).to.equal(1)
    expect(postedPayload.author.ebookMetadataProfileId).to.equal(2)
    expect(postedPayload.addOptions.searchForNewBook).to.be.true()
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
        return { data: { id: 100 + posts.length, title: payload.title } }
      }
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
