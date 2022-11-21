import { flatten, omit, uniq } from 'lodash';
import { Unsubscribable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import {
  CoreApp,
  DataQuery,
  DataQueryRequest,
  DataSourceApi,
  DataSourceRef,
  dateMath,
  DateTime,
  DefaultTimeZone,
  ExploreUrlState,
  HistoryItem,
  IntervalValues,
  isDateTime,
  LogsDedupStrategy,
  LogsSortOrder,
  rangeUtil,
  RawTimeRange,
  TimeFragment,
  TimeRange,
  TimeZone,
  toUtc,
  urlUtil,
} from '@grafana/data';
import { DataSourceSrv, getDataSourceSrv } from '@grafana/runtime';
import { RefreshPicker } from '@grafana/ui';
import store from 'app/core/store';
import { TimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { PanelModel } from 'app/features/dashboard/state';
import { ExploreId, QueryOptions, QueryTransaction } from 'app/types/explore';

import { config } from '../config';

import { getNextRefIdChar } from './query';

export const DEFAULT_RANGE = {
  from: 'now-1h',
  to: 'now',
};

export const DEFAULT_UI_STATE = {
  dedupStrategy: LogsDedupStrategy.none,
};

const MAX_HISTORY_ITEMS = 100;

export const LAST_USED_DATASOURCE_KEY = 'grafana.explore.datasource';
export const lastUsedDatasourceKeyForOrgId = (orgId: number) => `${LAST_USED_DATASOURCE_KEY}.${orgId}`;

export interface GetExploreUrlArguments {
  panel: PanelModel;
  /** Datasource service to query other datasources in case the panel datasource is mixed */
  datasourceSrv: DataSourceSrv;
  /** Time service to get the current dashboard range from */
  timeSrv: TimeSrv;
}

/**
 * Returns an Explore-URL that contains a panel's queries and the dashboard time range.
 */
export async function getExploreUrl(args: GetExploreUrlArguments): Promise<string | undefined> {
  const { panel, datasourceSrv, timeSrv } = args;
  let exploreDatasource = await datasourceSrv.get(panel.datasource);

  /** In Explore, we don't have legend formatter and we don't want to keep
   * legend formatting as we can't change it
   */
  let exploreTargets: DataQuery[] = panel.targets.map((t) => omit(t, 'legendFormat'));
  let url: string | undefined;
  // if the mixed datasource is not enabled for explore, choose only one datasource
  if (
    config.featureToggles.exploreMixedDatasource === false &&
    exploreDatasource.meta?.id === 'mixed' &&
    exploreTargets
  ) {
    // Find first explore datasource among targets
    for (const t of exploreTargets) {
      const datasource = await datasourceSrv.get(t.datasource || undefined);
      if (datasource) {
        exploreDatasource = datasource;
        exploreTargets = panel.targets.filter((t) => t.datasource === datasource.name);
        break;
      }
    }
  }

  if (exploreDatasource) {
    const range = timeSrv.timeRangeForUrl();
    let state: Partial<ExploreUrlState> = { range };
    if (exploreDatasource.interpolateVariablesInQueries) {
      const scopedVars = panel.scopedVars || {};
      state = {
        ...state,
        datasource: exploreDatasource.name,
        context: 'explore',
        queries: exploreDatasource.interpolateVariablesInQueries(exploreTargets, scopedVars),
      };
    } else {
      state = {
        ...state,
        datasource: exploreDatasource.name,
        context: 'explore',
        queries: exploreTargets,
      };
    }

    const exploreState = JSON.stringify(state);
    url = urlUtil.renderUrl('/explore', { left: exploreState });
  }

  return url;
}

export function buildQueryTransaction(
  exploreId: ExploreId,
  queries: DataQuery[],
  queryOptions: QueryOptions,
  range: TimeRange,
  scanning: boolean,
  timeZone?: TimeZone
): QueryTransaction {
  const key = queries.reduce((combinedKey, query) => {
    combinedKey += query.key;
    return combinedKey;
  }, '');

  const { interval, intervalMs } = getIntervals(range, queryOptions.minInterval, queryOptions.maxDataPoints);

  // Most datasource is using `panelId + query.refId` for cancellation logic.
  // Using `format` here because it relates to the view panel that the request is for.
  // However, some datasources don't use `panelId + query.refId`, but only `panelId`.
  // Therefore panel id has to be unique.
  const panelId = `${key}`;

  const request: DataQueryRequest = {
    app: CoreApp.Explore,
    dashboardId: 0,
    // TODO probably should be taken from preferences but does not seem to be used anyway.
    timezone: timeZone || DefaultTimeZone,
    startTime: Date.now(),
    interval,
    intervalMs,
    // TODO: the query request expects number and we are using string here. Seems like it works so far but can create
    // issues down the road.
    panelId: panelId as any,
    targets: queries, // Datasources rely on DataQueries being passed under the targets key.
    range,
    requestId: 'explore_' + exploreId,
    rangeRaw: range.raw,
    scopedVars: {
      __interval: { text: interval, value: interval },
      __interval_ms: { text: intervalMs, value: intervalMs },
    },
    maxDataPoints: queryOptions.maxDataPoints,
    liveStreaming: queryOptions.liveStreaming,
  };

  return {
    queries,
    request,
    scanning,
    id: generateKey(), // reusing for unique ID
    done: false,
  };
}

export const clearQueryKeys: (query: DataQuery) => DataQuery = ({ key, ...rest }) => rest;

const isSegment = (segment: { [key: string]: string }, ...props: string[]) =>
  props.some((prop) => segment.hasOwnProperty(prop));

enum ParseUrlStateIndex {
  RangeFrom = 0,
  RangeTo = 1,
  Datasource = 2,
  SegmentsStart = 3,
}

export const safeParseJson = (text?: string): any | undefined => {
  if (!text) {
    return;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(error);
  }
};

export const safeStringifyValue = (value: any, space?: number) => {
  if (!value) {
    return '';
  }

  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    console.error(error);
  }

  return '';
};

export function parseUrlState(initial: string | undefined): ExploreUrlState {
  const parsed = safeParseJson(initial);
  const errorResult: any = {
    datasource: null,
    queries: [],
    range: DEFAULT_RANGE,
    mode: null,
  };

  if (!parsed) {
    return errorResult;
  }

  if (!Array.isArray(parsed)) {
    const urlState = { ...parsed, isFromCompactUrl: false };
    return urlState;
  }

  if (parsed.length <= ParseUrlStateIndex.SegmentsStart) {
    console.error('Error parsing compact URL state for Explore.');
    return errorResult;
  }

  const range = {
    from: parsed[ParseUrlStateIndex.RangeFrom],
    to: parsed[ParseUrlStateIndex.RangeTo],
  };
  const datasource = parsed[ParseUrlStateIndex.Datasource];
  const parsedSegments = parsed.slice(ParseUrlStateIndex.SegmentsStart);
  const queries = parsedSegments.filter((segment) => !isSegment(segment, 'ui', 'mode', '__panelsState'));

  const panelsState = parsedSegments.find((segment) => isSegment(segment, '__panelsState'))?.__panelsState;
  return { datasource, queries, range, panelsState, isFromCompactUrl: true };
}

export function generateKey(index = 0): string {
  return `Q-${uuidv4()}-${index}`;
}

export async function generateEmptyQuery(
  queries: DataQuery[],
  index = 0,
  dataSourceOverride?: DataSourceRef
): Promise<DataQuery> {
  let datasourceInstance: DataSourceApi | undefined;
  let datasourceRef: DataSourceRef | null | undefined;
  let defaultQuery: Partial<DataQuery> | undefined;

  // datasource override is if we have switched datasources with no carry-over - we want to create a new query with a datasource we define
  // it's also used if there's a root datasource and there were no previous queries
  if (dataSourceOverride) {
    datasourceRef = dataSourceOverride;
  } else if (queries.length > 0 && queries[queries.length - 1].datasource) {
    // otherwise use last queries' datasource
    datasourceRef = queries[queries.length - 1].datasource;
  } else {
    datasourceInstance = await getDataSourceSrv().get();
    defaultQuery = datasourceInstance.getDefaultQuery?.(CoreApp.Explore);
    datasourceRef = datasourceInstance.getRef();
  }

  if (!datasourceInstance) {
    datasourceInstance = await getDataSourceSrv().get(datasourceRef);
    defaultQuery = datasourceInstance.getDefaultQuery?.(CoreApp.Explore);
  }

  return { refId: getNextRefIdChar(queries), key: generateKey(index), datasource: datasourceRef, ...defaultQuery };
}

export const generateNewKeyAndAddRefIdIfMissing = (target: DataQuery, queries: DataQuery[], index = 0): DataQuery => {
  const key = generateKey(index);
  const refId = target.refId || getNextRefIdChar(queries);

  return { ...target, refId, key };
};

export const queryDatasourceDetails = (queries: DataQuery[]) => {
  const allUIDs = queries.map((query) => query.datasource?.uid);
  return {
    allHaveDatasource: allUIDs.length === queries.length,
    noneHaveDatasource: allUIDs.length === 0,
    allDatasourceSame: allUIDs.every((val, i, arr) => val === arr[0]),
  };
};

/**
 * Ensure at least one target exists and that targets have the necessary keys
 *
 * This will return an empty array if there are no datasources, as Explore is not usable in that state
 */
export async function ensureQueries(
  queries?: DataQuery[],
  newQueryDataSourceOverride?: DataSourceRef
): Promise<DataQuery[]> {
  if (queries && typeof queries === 'object' && queries.length > 0) {
    const allQueries = [];
    for (let index = 0; index < queries.length; index++) {
      const query = queries[index];
      const key = generateKey(index);
      let refId = query.refId;
      if (!refId) {
        refId = getNextRefIdChar(allQueries);
      }

      // if a query has a datasource, validate it and only add it if valid
      // if a query doesn't have a datasource, do not worry about it at this step
      let validDS = true;
      if (query.datasource) {
        try {
          await getDataSourceSrv().get(query.datasource.uid);
        } catch {
          console.error(`One of the queries has a datasource that is no longer available and was removed.`);
          validDS = false;
        }
      }

      if (validDS) {
        allQueries.push({
          ...query,
          refId,
          key,
        });
      }
    }
    return allQueries;
  }
  try {
    // if a datasource override get its ref, otherwise get the default datasource
    const emptyQueryRef = newQueryDataSourceOverride ?? (await getDataSourceSrv().get()).getRef();
    const emptyQuery = await generateEmptyQuery(queries ?? [], undefined, emptyQueryRef);
    return [emptyQuery];
  } catch {
    // if there are no datasources, return an empty array because we will not allow use of explore
    // this will occur on init of explore with no datasources defined
    return [];
  }
}

/**
 * A target is non-empty when it has keys (with non-empty values) other than refId, key, context and datasource.
 * FIXME: While this is reasonable for practical use cases, a query without any propery might still be "non-empty"
 * in its own scope, for instance when there's no user input needed. This might be the case for an hypothetic datasource in
 * which query options are only set in its config and the query object itself, as generated from its query editor it's always "empty"
 */
const validKeys = ['refId', 'key', 'context', 'datasource'];
export function hasNonEmptyQuery<TQuery extends DataQuery>(queries: TQuery[]): boolean {
  return (
    queries &&
    queries.some((query: any) => {
      const keys = Object.keys(query)
        .filter((key) => validKeys.indexOf(key) === -1)
        .map((k) => query[k])
        .filter((v) => v);
      return keys.length > 0;
    })
  );
}

/**
 * Update the query history. Side-effect: store history in local storage
 */
export function updateHistory<T extends DataQuery>(
  history: Array<HistoryItem<T>>,
  datasourceId: string,
  queries: T[]
): Array<HistoryItem<T>> {
  const ts = Date.now();
  let updatedHistory = history;
  queries.forEach((query) => {
    updatedHistory = [{ query, ts }, ...updatedHistory];
  });

  if (updatedHistory.length > MAX_HISTORY_ITEMS) {
    updatedHistory = updatedHistory.slice(0, MAX_HISTORY_ITEMS);
  }

  // Combine all queries of a datasource type into one history
  const historyKey = `grafana.explore.history.${datasourceId}`;
  try {
    store.setObject(historyKey, updatedHistory);
    return updatedHistory;
  } catch (error) {
    console.error(error);
    return history;
  }
}

export function clearHistory(datasourceId: string) {
  const historyKey = `grafana.explore.history.${datasourceId}`;
  store.delete(historyKey);
}

export const getQueryKeys = (queries: DataQuery[]): string[] => {
  const queryKeys = queries.reduce<string[]>((newQueryKeys, query, index) => {
    const primaryKey = query.datasource?.uid || query.key;
    return newQueryKeys.concat(`${primaryKey}-${index}`);
  }, []);

  return queryKeys;
};

export const getTimeRange = (timeZone: TimeZone, rawRange: RawTimeRange, fiscalYearStartMonth: number): TimeRange => {
  let range = rangeUtil.convertRawToRange(rawRange, timeZone, fiscalYearStartMonth);

  if (range.to.isBefore(range.from)) {
    range = rangeUtil.convertRawToRange({ from: range.raw.to, to: range.raw.from }, timeZone, fiscalYearStartMonth);
  }

  return range;
};

const parseRawTime = (value: string | DateTime): TimeFragment | null => {
  if (value === null) {
    return null;
  }

  if (isDateTime(value)) {
    return value;
  }

  if (value.indexOf('now') !== -1) {
    return value;
  }
  if (value.length === 8) {
    return toUtc(value, 'YYYYMMDD');
  }
  if (value.length === 15) {
    return toUtc(value, 'YYYYMMDDTHHmmss');
  }
  // Backward compatibility
  if (value.length === 19) {
    return toUtc(value, 'YYYY-MM-DD HH:mm:ss');
  }

  // This should handle cases where value is an epoch time as string
  if (value.match(/^\d+$/)) {
    const epoch = parseInt(value, 10);
    return toUtc(epoch);
  }

  // This should handle ISO strings
  const time = toUtc(value);
  if (time.isValid()) {
    return time;
  }

  return null;
};

export const getTimeRangeFromUrl = (
  range: RawTimeRange,
  timeZone: TimeZone,
  fiscalYearStartMonth: number
): TimeRange => {
  const raw = {
    from: parseRawTime(range.from)!,
    to: parseRawTime(range.to)!,
  };

  return {
    from: dateMath.parse(raw.from, false, timeZone as any)!,
    to: dateMath.parse(raw.to, true, timeZone as any)!,
    raw,
  };
};

export const getValueWithRefId = (value?: any): any => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (value.refId) {
    return value;
  }

  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const refId = getValueWithRefId(value[key]);
    if (refId) {
      return refId;
    }
  }

  return undefined;
};

export const getRefIds = (value: any): string[] => {
  if (!value) {
    return [];
  }

  if (typeof value !== 'object') {
    return [];
  }

  const keys = Object.keys(value);
  const refIds = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key === 'refId') {
      refIds.push(value[key]);
      continue;
    }
    refIds.push(getRefIds(value[key]));
  }

  return uniq(flatten(refIds));
};

export const refreshIntervalToSortOrder = (refreshInterval?: string) =>
  RefreshPicker.isLive(refreshInterval) ? LogsSortOrder.Ascending : LogsSortOrder.Descending;

export const convertToWebSocketUrl = (url: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  let backend = `${protocol}${window.location.host}${config.appSubUrl}`;
  if (backend.endsWith('/')) {
    backend = backend.slice(0, -1);
  }
  return `${backend}${url}`;
};

export const stopQueryState = (querySubscription: Unsubscribable | undefined) => {
  if (querySubscription) {
    querySubscription.unsubscribe();
  }
};

export function getIntervals(range: TimeRange, lowLimit?: string, resolution?: number): IntervalValues {
  if (!resolution) {
    return { interval: '1s', intervalMs: 1000 };
  }

  return rangeUtil.calculateInterval(range, resolution, lowLimit);
}

export const copyStringToClipboard = (string: string) => {
  const el = document.createElement('textarea');
  el.value = string;
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
};
