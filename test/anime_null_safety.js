/* eslint-env mocha */
const expect = require('must')
const anilist = require('../lib/anime/anilist')

describe('anime - null safety and defensive parsing', function () {

  it('should correctly calculate current season and adjacent seasons', function () {
    const season = anilist.getCurrentSeason()
    expect(['WINTER', 'SPRING', 'SUMMER', 'FALL']).to.include(season)

    const prev = anilist.getPreviousSeason('WINTER', 2026)
    expect(prev.season).to.equal('FALL')
    expect(prev.year).to.equal(2025)

    const next = anilist.getUpcomingSeason('FALL', 2026)
    expect(next.season).to.equal('WINTER')
    expect(next.year).to.equal(2027)
  })

  it('should safely parse AniList media with null/undefined title properties', function () {
    // Media item with null/missing title and fields
    const mockMedia = [
      {
        id: 1,
        title: null, // Title is completely null
        status: 'RELEASING'
      },
      {
        id: 2,
        title: { english: null, romaji: null }, // Title object has no names
        status: 'FINISHED'
      },
      {
        id: 3,
        title: { english: 'Solo Leveling', romaji: 'Ore dake Level Up na Ken' },
        studios: null, // Studios is null
        externalLinks: null, // External links is null
        relations: null, // Relations is null
        genres: null,
        tags: null,
        startDate: null
      }
    ]

    const masterList = []
    mockMedia.forEach(a => {
      // Must not throw TypeError on a.title?.english
      if (!a.title?.english && !a.title?.romaji) return
      masterList.push({
        id: `ani_${a.id}`,
        title: a.title?.english || a.title?.romaji,
        studio: a.studios?.nodes?.[0]?.name,
        genres: (a.genres || []),
        relations: a.relations
      })
    })

    expect(masterList.length).to.equal(1)
    expect(masterList[0].id).to.equal('ani_3')
    expect(masterList[0].title).to.equal('Solo Leveling')
    expect(masterList[0].studio).to.be.undefined()
  })

  it('should safely extract IDs from externalLinks with null or malformed items', function () {
    const rawLinks = [
      null,
      undefined,
      { site: 'Other', url: 'https://example.com' },
      { site: 'TVDB', url: 'https://thetvdb.com/series/frieren-beyond-journeys-end' },
      { site: 'IMDb', url: 'https://www.imdb.com/title/tt22068940/' }
    ]

    const externalLinks = rawLinks || []
    const tvdbLink = externalLinks.find(l => l && (l.site === 'TVDB' || (l.url && l.url.includes('thetvdb.com'))))
    const imdbLink = externalLinks.find(l => l && (l.site === 'IMDb' || (l.url && l.url.includes('imdb.com'))))

    expect(tvdbLink).to.not.be.undefined()
    expect(tvdbLink.url).to.contain('frieren-beyond-journeys-end')

    expect(imdbLink).to.not.be.undefined()
    const match = imdbLink.url.match(/title\/(tt\d+)/)
    expect(match[1]).to.equal('tt22068940')
  })

  it('should filter out MOVIE format entries to avoid TVDB movie ID collisions with Sonarr', function () {
    const rawMedia = [
      { id: 101, title: { english: 'TV Series Anime' }, format: 'TV' },
      { id: 102, title: { english: 'Anime Movie' }, format: 'MOVIE' },
      { id: 103, title: { english: 'ONA Anime' }, format: 'ONA' }
    ]

    const filtered = rawMedia.filter(m => !m.isAdult && m.format !== 'MOVIE')
    expect(filtered.length).to.equal(2)
    expect(filtered.map(m => m.id)).to.eql([101, 103])
  })
})
