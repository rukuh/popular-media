const axios = require('axios');
const _ = require('lodash');

const SIMKL_API_URL = 'https://api.simkl.com';
const CLIENT_ID = process.env.SIMKL_CLIENT_ID;

module.exports.getTrending = async function () {
  try {
    const response = await axios.get(`${SIMKL_API_URL}/anime/trending?extended=full&client_id=${CLIENT_ID}`);
    return _.get(response, 'data', []).map(m => {
      const isMovie = m.anime_type === 'movie' || m.type === 'movie';
      return {
        mal_id: m.ids.mal,
        simkl_id: m.ids.simkl,
        tvdb_id: isMovie ? null : m.ids.tvdb,
        anime_type: m.anime_type,
        title: m.title
      };
    });
  } catch (error) {
    console.error('Simkl Trending Error:', error.message);
    return [];
  }
};

module.exports.getMetadata = async function (malId) {
  try {
    // 1. Search for Simkl ID by MAL ID
    const searchResponse = await axios.get(`${SIMKL_API_URL}/search/id?mal=${malId}&client_id=${CLIENT_ID}`);
    const simklId = _.get(searchResponse, 'data[0].ids.simkl');
    
    if (!simklId) return null;

    return module.exports.getFullMetadata(simklId);
  } catch (e) {
    return null;
  }
};

module.exports.getFullMetadata = async function (simklId) {
  try {
    const fullResponse = await axios.get(`${SIMKL_API_URL}/anime/${simklId}?extended=full&client_id=${CLIENT_ID}`);
    const data = fullResponse.data;

    const isMovie = _.get(data, 'anime_type') === 'movie' || _.get(data, 'type') === 'movie';
    return {
      tvdb_id: isMovie ? null : _.get(data, 'ids.tvdb'),
      imdb_id: _.get(data, 'ids.imdb'),
      anime_type: _.get(data, 'anime_type'),
      simkl_id: simklId
    };
  } catch (e) {
    return null;
  }
};
