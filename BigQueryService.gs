/**
 * ==============================================
 * BIGQUERYSERVICE.gs - BigQuery Operations (Template)
 * ==============================================
 * Minimal helper functions for BigQuery access.
 */

/**
 * Run a BigQuery query with optional parameters
 * @param {string} sql - The SQL query
 * @param {Array} params - Query parameters (optional)
 * @returns {Object} Query results
 */
function runQuery_(sql, params) {
  const location = resolveQueryLocation_(sql);
  const timeoutMs = 30000;
  const request = {
    query: sql,
    useLegacySql: false,
    timeoutMs: timeoutMs
  };
  
  if (location) {
    request.location = location;
  }
  
  if (params && params.length) {
    request.parameterMode = 'NAMED';
    request.queryParameters = params;
  }
  
  try {
    let queryResults = BigQuery.Jobs.query(request, CONFIG.PROJECT_ID);
    const deadline = Date.now() + timeoutMs;
    const jobReference = queryResults.jobReference || {};
    const jobProjectId = jobReference.projectId || CONFIG.PROJECT_ID;
    const jobId = jobReference.jobId;
    const jobLocation = jobReference.location || location || '';
    
    while (!queryResults.jobComplete && jobId && Date.now() < deadline) {
      Utilities.sleep(1000);
      try {
        if (jobLocation) {
          queryResults = BigQuery.Jobs.getQueryResults(jobProjectId, jobId, { location: jobLocation });
        } else {
          queryResults = BigQuery.Jobs.getQueryResults(jobProjectId, jobId);
        }
      } catch (err) {
        const errMsg = String(err || '');
        if (errMsg.indexOf('Not found: Job') !== -1 && jobLocation) {
          queryResults = BigQuery.Jobs.getQueryResults(jobProjectId, jobId);
        } else {
          throw err;
        }
      }
    }
    
    if (!queryResults.jobComplete) {
      throw new Error('Query did not complete within ' + timeoutMs + 'ms.');
    }

    // Fetch remaining pages (if any) so callers get a complete row set.
    if (queryResults.pageToken && jobId) {
      const allRows = (queryResults.rows || []).slice();
      let pageToken = queryResults.pageToken;
      while (pageToken && Date.now() < deadline) {
        const opts = { pageToken: pageToken, maxResults: 1000 };
        if (jobLocation) opts.location = jobLocation;
        const page = BigQuery.Jobs.getQueryResults(jobProjectId, jobId, opts);
        if (page && page.rows && page.rows.length) {
          allRows.push.apply(allRows, page.rows);
        }
        pageToken = page.pageToken;
      }
      queryResults.rows = allRows;
      delete queryResults.pageToken;
    }

    return queryResults;
  } catch (e) {
    throw new Error('Database error: ' + e.message);
  }
}

function resolveQueryLocation_(sql) {
  if (typeof CONFIG !== 'undefined' && CONFIG.BQ_LOCATION) {
    return CONFIG.BQ_LOCATION;
  }
  
  const candidates = extractDatasetCandidates_(sql);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const location = getDatasetLocation_(candidate.projectId, candidate.datasetId);
    if (location) return location;
  }
  
  if (typeof CONFIG !== 'undefined' && CONFIG.PROJECT_ID && CONFIG.DATASET_ID) {
    return getDatasetLocation_(CONFIG.PROJECT_ID, CONFIG.DATASET_ID) || '';
  }
  
  return '';
}

function extractDatasetCandidates_(sql) {
  const candidates = [];
  const seen = {};
  if (!sql) return candidates;
  
  const regex = /`([^`]+)`/g;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    const parts = match[1].split('.');
    let projectId = '';
    let datasetId = '';
    
    if (parts.length >= 3) {
      projectId = parts[0];
      datasetId = parts[1];
    } else if (parts.length === 2) {
      projectId = CONFIG && CONFIG.PROJECT_ID ? CONFIG.PROJECT_ID : '';
      datasetId = parts[0];
    }
    
    if (projectId && datasetId) {
      const key = projectId + ':' + datasetId;
      if (!seen[key]) {
        seen[key] = true;
        candidates.push({ projectId: projectId, datasetId: datasetId });
      }
    }
  }
  
  return candidates;
}

function getDatasetLocation_(projectId, datasetId) {
  if (!projectId || !datasetId) return '';
  
  const cache = CacheService.getScriptCache();
  const cacheKey = 'bq_loc_' + projectId + '_' + datasetId;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  try {
    const dataset = BigQuery.Datasets.get(projectId, datasetId);
    const location = dataset && dataset.location ? dataset.location : '';
    if (location) {
      cache.put(cacheKey, location, 21600);
    }
    return location;
  } catch (e) {
    return '';
  }
}

/**
 * Create a BigQuery parameter
 * @param {string} name - Parameter name
 * @param {string} type - Parameter type (STRING, DATE, INT64, etc.)
 * @param {*} value - Parameter value
 * @returns {Object} BigQuery parameter object
 */
function toBQParam_(name, type, value) {
  const normalizedValue = value === null || typeof value === 'undefined'
    ? null
    : String(value);
  return {
    name: name,
    parameterType: { type: type },
    parameterValue: { value: normalizedValue }
  };
}

/**
 * Parse BigQuery rows into objects
 * @param {Object} result - BigQuery result object
 * @param {Array} fieldNames - Array of field names in order
 * @returns {Array} Array of objects
 */
function parseRows_(result, fieldNames) {
  const rows = result.rows || [];
  
  return rows.map(r => {
    const obj = {};
    fieldNames.forEach((name, i) => {
      obj[name] = r.f[i] ? r.f[i].v : null;
    });
    return obj;
  });
}

/** Convert BigQuery API rows using the returned schema. */
function rowsToObjects_(result) {
  const fields = result && result.schema && result.schema.fields ? result.schema.fields : [];
  const rows = result && result.rows ? result.rows : [];
  return rows.map(function(row) {
    return bqRecordToObject_(fields, row.f || []);
  });
}

function bqRecordToObject_(fields, cells) {
  const output = {};
  fields.forEach(function(field, index) {
    const cell = cells[index] || {};
    output[field.name] = bqValueToJs_(field, cell.v);
  });
  return output;
}

function bqValueToJs_(field, value) {
  if (value === null || typeof value === 'undefined') return null;

  if (field.mode === 'REPEATED') {
    const repeatedField = Object.assign({}, field, { mode: 'NULLABLE' });
    return (value || []).map(function(item) {
      return bqValueToJs_(repeatedField, item && Object.prototype.hasOwnProperty.call(item, 'v') ? item.v : item);
    });
  }

  if (field.type === 'RECORD' || field.type === 'STRUCT') {
    return bqRecordToObject_(field.fields || [], value.f || []);
  }
  if (field.type === 'BOOL' || field.type === 'BOOLEAN') {
    return value === true || value === 'true' || value === 'TRUE' || value === '1' || value === 1;
  }
  if (['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].indexOf(field.type) !== -1) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return value;
}

function queryObjects_(sql, params) {
  return rowsToObjects_(runQuery_(sql, params));
}

function generateUUID_() {
  return Utilities.getUuid();
}
