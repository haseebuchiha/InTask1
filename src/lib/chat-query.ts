import * as zod from "zod"

const PING_COLUMNS = ["id", "createdAt", "statusCode", "durationMs", "error", "responseKind", "origin"] as const

const RESPONSE_KINDS = ["clean_echo", "echo_mismatch", "empty", "client_error", "gateway_error", "failed"] as const

const PING_NUMBER_COLUMNS = ["durationMs", "statusCode"] as const

const INCIDENT_COLUMNS = [
  "id",
  "createdAt",
  "pingId",
  "severity",
  "durationMs",
  "averageDurationMs",
  "reportStatus",
  "summary",
  "inputTokens",
  "outputTokens",
] as const

const INCIDENT_NUMBER_COLUMNS = ["durationMs", "averageDurationMs", "inputTokens", "outputTokens"] as const

const AGGREGATE_KEYS = ["_count", "_avg", "_sum", "_min", "_max"] as const

const AGGREGATE_WORDS: Record<AggregateKey, string> = {
  _count: "count",
  _avg: "average",
  _sum: "total",
  _min: "lowest",
  _max: "highest",
}

const TABLE_NOUNS = { ping: "pings", incident: "incidents" }

export type ChatQuery = zod.infer<typeof chatQuerySchema>

export type PingChatQuery = Extract<ChatQuery, { table: "ping" }>

export type IncidentChatQuery = Extract<ChatQuery, { table: "incident" }>

type FilterValues = Record<string, unknown>

type DescribableArguments = {
  where?: FilterValues
  orderBy?: Record<string, string | undefined>[]
  skip?: number
  take?: number
  by?: string[]
} & Partial<Record<AggregateKey, true | FilterValues>>

type AggregateKey = (typeof AGGREGATE_KEYS)[number]

export const describeChatQuery = (query: unknown) => {
  const parsedQuery = chatQuerySchema.safeParse(query)
  return parsedQuery.success ? describeParsedQuery(parsedQuery.data) : "a query the monitor can't read"
}

const describeParsedQuery = (query: ChatQuery) =>
  queryDescribers[query.method](TABLE_NOUNS[query.table], query.arguments)

const describeFindMany = (noun: string, queryArguments: DescribableArguments) =>
  `${noun}${describeWhere(queryArguments.where)}${describeOrder(queryArguments.orderBy)}${describeSkip(queryArguments.skip)}, ${queryArguments.take} rows`

const describeAggregate = (noun: string, queryArguments: DescribableArguments) =>
  `${describeAggregates(queryArguments).join(", ")} of ${noun}${describeWhere(queryArguments.where)}`

const describeGroupBy = (noun: string, queryArguments: DescribableArguments) =>
  `${noun} grouped by ${queryArguments.by?.join(", ")}${describeGroupAggregates(queryArguments)}${describeWhere(queryArguments.where)}${describeOrder(queryArguments.orderBy)}${describeLimit(queryArguments.take)}`

const describeWhere = (where: FilterValues = {}) => {
  const conditions = describeConditions(where)
  return conditions.length > 0 ? ` where ${conditions.join(" and ")}` : ""
}

const describeConditions = (where: FilterValues): string[] => Object.entries(where).flatMap(describeCondition)

const describeCondition = ([column, filter]: [string, unknown]) =>
  groupJoiners.has(column)
    ? [describeConditionGroup(column, filter as FilterValues[])]
    : describeColumnFilter(column, filter)

const describeConditionGroup = (column: string, wheres: FilterValues[]) =>
  `(${wheres.map((where) => describeConditions(where).join(" and ")).join(groupJoiners.get(column))})`

const describeColumnFilter = (column: string, filter: unknown) =>
  Object.entries(toOperators(filter)).map(
    ([operator, value]) => `${column} ${operatorWords.get(operator)} ${formatValue(value)}`,
  )

const toOperators = (filter: unknown): FilterValues => (isOperatorObject(filter) ? filter : { equals: filter })

const isOperatorObject = (filter: unknown): filter is FilterValues =>
  typeof filter === "object" && filter !== null && !(filter instanceof Date)

const formatValue = (value: unknown): string =>
  Array.isArray(value) ? `(${value.map(formatValue).join(", ")})` : formatScalar(value)

const formatScalar = (value: unknown) => (value instanceof Date ? value.toISOString() : JSON.stringify(value))

const describeOrder = (orderBy: Record<string, string | undefined>[] = []) =>
  orderBy
    .flatMap((entry) => Object.entries(entry))
    .map(([column, direction]) => `, ${describeSortEntry(column, String(direction))}`)
    .join("")

const describeSortEntry = (column: string, direction: string) =>
  sortPhrases.get(`${column} ${direction}`) ?? `by ${column} ${direction}ending`

const describeSkip = (skip = 0) => (skip > 0 ? `, skipping ${skip}` : "")

const describeLimit = (take?: number) => (take === undefined ? "" : `, ${take} groups`)

const describeGroupAggregates = (queryArguments: DescribableArguments) => {
  const aggregates = describeAggregates(queryArguments)
  return aggregates.length > 0 ? ` with ${aggregates.join(", ")}` : ""
}

const describeAggregates = (queryArguments: DescribableArguments) =>
  AGGREGATE_KEYS.flatMap((key) => describeAggregateColumns(key, queryArguments[key]))

const describeAggregateColumns = (key: AggregateKey, selection?: true | FilterValues) =>
  selection === true
    ? [AGGREGATE_WORDS[key]]
    : Object.keys(selection ?? {}).map((column) => `${AGGREGATE_WORDS[key]} ${column}`)

const toDate = (text: string) => new Date(text)

const namesOneColumn = (entry: object) => Object.keys(entry).length === 1

const selectsAColumn = (selection: object) => Object.values(selection).includes(true)

const asksForAnAggregate = (queryArguments: object) => AGGREGATE_KEYS.some((key) => key in queryArguments)

const ordersWhenTaking = (queryArguments: { take?: number; orderBy?: unknown[] }) =>
  queryArguments.take === undefined || queryArguments.orderBy !== undefined

const ordersByGroupedColumns = (queryArguments: { by: string[]; orderBy?: object[] }) =>
  (queryArguments.orderBy ?? [])
    .flatMap((entry) => Object.keys(entry))
    .every((column) => queryArguments.by.includes(column))

const shapeOf = <Column extends string, Value>(columns: readonly Column[], value: Value) =>
  Object.fromEntries(columns.map((column) => [column, value])) as Record<Column, Value>

const columnFilter = <Value extends zod.ZodType, Operators extends zod.ZodRawShape>(
  value: Value,
  operators: Operators,
) => zod.union([value, zod.strictObject({ equals: value, not: value, ...operators }).partial()])

const rangeOperators = <Value extends zod.ZodType>(value: Value) => ({
  gt: value,
  gte: value,
  lt: value,
  lte: value,
  in: zod.array(value),
})

const textOperators = { in: zod.array(zod.string()), contains: zod.string(), startsWith: zod.string() }

const whereSchema = <Filters extends zod.ZodRawShape>(filters: Filters) => {
  const columnFilters = zod.strictObject(filters).partial()
  return columnFilters.extend({ AND: zod.array(columnFilters).optional(), OR: zod.array(columnFilters).optional() })
}

const orderBySchema = <Column extends string>(columns: readonly Column[]) =>
  zod.array(
    zod
      .strictObject(shapeOf(columns, sortDirection))
      .partial()
      .refine(namesOneColumn, "Each orderBy entry names exactly one column"),
  )

const selectSchema = <Column extends string>(columns: readonly Column[]) =>
  zod
    .strictObject(shapeOf(columns, zod.boolean()))
    .partial()
    .refine(selectsAColumn, "select needs at least one column set to true")

const aggregateSchema = <Column extends string>(columns: readonly Column[]) =>
  zod.strictObject(shapeOf(columns, zod.literal(true))).partial()

const aggregateShape = <NumberColumn extends string>(numberColumns: readonly NumberColumn[]) => ({
  _count: zod.literal(true).optional(),
  _avg: aggregateSchema(numberColumns).optional(),
  _sum: aggregateSchema(numberColumns).optional(),
  _min: aggregateSchema([...numberColumns, "createdAt"]).optional(),
  _max: aggregateSchema([...numberColumns, "createdAt"]).optional(),
})

const sortDirection = zod.enum(["asc", "desc"])

const wholeNumber = zod.number().int()

const isoDate = zod.union([
  zod.date(),
  zod.union([zod.iso.datetime({ offset: true }), zod.iso.date()]).transform(toDate),
])

const numberFilter = columnFilter(wholeNumber, rangeOperators(wholeNumber))

const nullableNumberFilter = columnFilter(wholeNumber.nullable(), rangeOperators(wholeNumber))

const dateFilter = columnFilter(isoDate, rangeOperators(isoDate))

const textFilter = columnFilter(zod.string(), textOperators)

const nullableTextFilter = columnFilter(zod.string().nullable(), textOperators)

const responseKind = zod.enum(RESPONSE_KINDS)

const responseKindFilter = columnFilter(responseKind, { in: zod.array(responseKind) })

const takeSchema = zod.number().int().min(1).max(100)

const pingWhere = whereSchema({
  id: numberFilter,
  createdAt: dateFilter,
  statusCode: nullableNumberFilter,
  durationMs: numberFilter,
  error: nullableTextFilter,
  responseKind: responseKindFilter,
  origin: nullableTextFilter,
})

const incidentWhere = whereSchema({
  id: numberFilter,
  createdAt: dateFilter,
  pingId: numberFilter,
  severity: textFilter,
  durationMs: numberFilter,
  averageDurationMs: numberFilter,
  reportStatus: textFilter,
  summary: nullableTextFilter,
  inputTokens: numberFilter,
  outputTokens: numberFilter,
})

const pingFindManyArguments = zod.strictObject({
  where: pingWhere.optional(),
  orderBy: orderBySchema(PING_COLUMNS).optional(),
  select: selectSchema([...PING_COLUMNS, "payload", "response"]).default(shapeOf(PING_COLUMNS, true)),
  skip: zod.number().int().min(0).optional(),
  take: takeSchema.default(20),
})

const incidentFindManyArguments = zod.strictObject({
  where: incidentWhere.optional(),
  orderBy: orderBySchema(INCIDENT_COLUMNS).optional(),
  select: selectSchema([...INCIDENT_COLUMNS, "likelyCauses", "recommendations"]).optional(),
  skip: zod.number().int().min(0).optional(),
  take: takeSchema.default(20),
})

const pingAggregateArguments = zod
  .strictObject({ where: pingWhere.optional(), ...aggregateShape(PING_NUMBER_COLUMNS) })
  .refine(asksForAnAggregate, "aggregate needs at least one of _count, _avg, _sum, _min or _max")

const incidentAggregateArguments = zod
  .strictObject({ where: incidentWhere.optional(), ...aggregateShape(INCIDENT_NUMBER_COLUMNS) })
  .refine(asksForAnAggregate, "aggregate needs at least one of _count, _avg, _sum, _min or _max")

const pingGroupByArguments = zod
  .strictObject({
    where: pingWhere.optional(),
    by: zod.array(zod.enum(PING_COLUMNS)).min(1),
    ...aggregateShape(PING_NUMBER_COLUMNS),
    orderBy: orderBySchema(PING_COLUMNS).optional(),
    take: takeSchema.optional(),
  })
  .refine(ordersWhenTaking, { message: "groupBy needs orderBy when it uses take", path: ["orderBy"] })
  .refine(ordersByGroupedColumns, { message: "groupBy can only order by columns listed in by", path: ["orderBy"] })

const incidentGroupByArguments = zod
  .strictObject({
    where: incidentWhere.optional(),
    by: zod.array(zod.enum(INCIDENT_COLUMNS)).min(1),
    ...aggregateShape(INCIDENT_NUMBER_COLUMNS),
    orderBy: orderBySchema(INCIDENT_COLUMNS).optional(),
    take: takeSchema.optional(),
  })
  .refine(ordersWhenTaking, { message: "groupBy needs orderBy when it uses take", path: ["orderBy"] })
  .refine(ordersByGroupedColumns, { message: "groupBy can only order by columns listed in by", path: ["orderBy"] })

const pingQuerySchema = zod.discriminatedUnion("method", [
  zod.strictObject({ table: zod.literal("ping"), method: zod.literal("findMany"), arguments: pingFindManyArguments }),
  zod.strictObject({ table: zod.literal("ping"), method: zod.literal("aggregate"), arguments: pingAggregateArguments }),
  zod.strictObject({ table: zod.literal("ping"), method: zod.literal("groupBy"), arguments: pingGroupByArguments }),
])

const incidentQuerySchema = zod.discriminatedUnion("method", [
  zod.strictObject({
    table: zod.literal("incident"),
    method: zod.literal("findMany"),
    arguments: incidentFindManyArguments,
  }),
  zod.strictObject({
    table: zod.literal("incident"),
    method: zod.literal("aggregate"),
    arguments: incidentAggregateArguments,
  }),
  zod.strictObject({
    table: zod.literal("incident"),
    method: zod.literal("groupBy"),
    arguments: incidentGroupByArguments,
  }),
])

export const chatQuerySchema = zod.discriminatedUnion("table", [pingQuerySchema, incidentQuerySchema])

const queryDescribers = { findMany: describeFindMany, aggregate: describeAggregate, groupBy: describeGroupBy }

const groupJoiners = new Map([
  ["AND", " and "],
  ["OR", " or "],
])

const operatorWords = new Map([
  ["equals", "="],
  ["not", "!="],
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
  ["in", "in"],
  ["contains", "contains"],
  ["startsWith", "starts with"],
])

const sortPhrases = new Map([
  ["createdAt desc", "newest first"],
  ["createdAt asc", "oldest first"],
])
