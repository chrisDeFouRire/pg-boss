const assert = require('node:assert')
const { DEFAULT_SCHEMA } = require('./plans')

const POLICY = {
  MAX_EXPIRATION_HOURS: 24,
  MIN_POLLING_INTERVAL_MS: 500
}

module.exports = {
  POLICY,
  getConfig,
  checkSendArgs,
  checkQueueArgs,
  checkWorkArgs,
  checkFetchArgs,
  warnClockSkew,
  assertPostgresObjectName,
  assertQueueName
}

const WARNINGS = {
  CLOCK_SKEW: {
    message: 'Timekeeper detected clock skew between this instance and the database server. This will not affect scheduling operations, but this warning is shown any time the skew exceeds 60 seconds.',
    code: 'pg-boss-w02'
  },
  CRON_DISABLED: {
    message: 'Archive interval is set less than 60s.  Cron processing is disabled.',
    code: 'pg-boss-w03'
  },
  ON_COMPLETE_REMOVED: {
    message: '\'onComplete\' option detected. This option has been removed. Consider deadLetter if needed.',
    code: 'pg-boss-w04'
  }
}

function checkQueueArgs (name, options = {}) {
  assert(!('deadLetter' in options) || (typeof options.deadLetter === 'string'), 'deadLetter must be a string')

  applyRetryConfig(options)
  applyExpirationConfig(options)
  applyRetentionConfig(options)

  return options
}

function checkSendArgs (args, defaults) {
  let name, data, options

  if (typeof args[0] === 'string') {
    name = args[0]
    data = args[1]

    assert(typeof data !== 'function', 'send() cannot accept a function as the payload.  Did you intend to use work()?')

    options = args[2]
  } else if (typeof args[0] === 'object') {
    assert(args.length === 1, 'send object API only accepts 1 argument')

    const job = args[0]

    assert(job, 'boss requires all jobs to have a name')

    name = job.name
    data = job.data
    options = job.options
  }

  options = options || {}

  assert(name, 'boss requires all jobs to have a queue name')
  assert(typeof options === 'object', 'options should be an object')

  options = { ...options }

  assert(!('priority' in options) || (Number.isInteger(options.priority)), 'priority must be an integer')
  options.priority = options.priority || 0

  assert(!('deadLetter' in options) || (typeof options.deadLetter === 'string'), 'deadLetter must be a string')

  applyRetryConfig(options, defaults)
  applyExpirationConfig(options, defaults)
  applyRetentionConfig(options, defaults)

  const { startAfter, singletonSeconds, singletonMinutes, singletonHours } = options

  options.startAfter = (startAfter instanceof Date && typeof startAfter.toISOString === 'function')
    ? startAfter.toISOString()
    : (startAfter > 0)
        ? '' + startAfter
        : (typeof startAfter === 'string')
            ? startAfter
            : null

  options.singletonSeconds = (singletonHours > 0)
    ? singletonHours * 60 * 60
    : (singletonMinutes > 0)
        ? singletonMinutes * 60
        : (singletonSeconds > 0)
            ? singletonSeconds
            : null

  assert(!singletonSeconds || singletonSeconds <= defaults.archiveSeconds, `throttling interval ${singletonSeconds}s cannot exceed archive interval ${defaults.archiveSeconds}s`)

  if (options.onComplete) {
    emitWarning(WARNINGS.ON_COMPLETE_REMOVED)
  }

  return { name, data, options }
}

function checkWorkArgs (name, args, defaults) {
  let options, callback

  assert(name, 'missing job name')

  if (args.length === 1) {
    callback = args[0]
    options = {}
  } else if (args.length > 1) {
    options = args[0] || {}
    callback = args[1]
  }

  assert(typeof callback === 'function', 'expected callback to be a function')
  assert(typeof options === 'object', 'expected config to be an object')

  options = { ...options }

  applyPollingInterval(options, defaults)

  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')
  assert(!('priority' in options) || typeof options.priority === 'boolean', 'priority must be a boolean')

  options.batchSize = options.batchSize || 1

  return { options, callback }
}

function checkFetchArgs (name, options) {
  assert(name, 'missing queue name')

  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')
  assert(!('priority' in options) || typeof options.priority === 'boolean', 'priority must be a boolean')
  assert(!('ignoreStartAfter' in options) || typeof options.ignoreStartAfter === 'boolean', 'ignoreStartAfter must be a boolean')

  options.batchSize = options.batchSize || 1
}

function getConfig (value) {
  assert(value && (typeof value === 'object' || typeof value === 'string'),
    'configuration assert: string or config object is required to connect to postgres')

  const config = (typeof value === 'string')
    ? { connectionString: value }
    : { ...value }

  config.schedule = ('schedule' in config) ? config.schedule : true
  config.supervise = ('supervise' in config) ? config.supervise : true
  config.migrate = ('migrate' in config) ? config.migrate : true

  applySchemaConfig(config)
  applyMaintenanceConfig(config)
  applyArchiveConfig(config)
  applyArchiveFailedConfig(config)
  applyDeleteConfig(config)
  applyMonitoringConfig(config)

  applyPollingInterval(config)
  applyExpirationConfig(config)
  applyRetentionConfig(config)

  return config
}

function applySchemaConfig (config) {
  if (config.schema) {
    assertPostgresObjectName(config.schema)
  }

  config.schema = config.schema || DEFAULT_SCHEMA
}

function assertPostgresObjectName (name) {
  assert(typeof name === 'string', 'Name must be a string')
  assert(name.length <= 50, 'Name cannot exceed 50 characters')
  assert(!/\W/.test(name), 'Name can only contain alphanumeric characters or underscores')
  assert(!/^\d/.test(name), 'Name cannot start with a number')
}

function assertQueueName (name) {
  assert(name, 'Name is required')
  assert(typeof name === 'string', 'Name must be a string')
  assert(/[\w-]/.test(name), 'Name can only contain alphanumeric characters, underscores, or hyphens')
}

function applyArchiveConfig (config) {
  const ARCHIVE_DEFAULT = 60 * 60 * 12

  assert(!('archiveCompletedAfterSeconds' in config) || config.archiveCompletedAfterSeconds >= 1,
    'configuration assert: archiveCompletedAfterSeconds must be at least every second and less than ')

  config.archiveSeconds = config.archiveCompletedAfterSeconds || ARCHIVE_DEFAULT
  config.archiveInterval = `${config.archiveSeconds} seconds`

  if (config.archiveSeconds < 60) {
    emitWarning(WARNINGS.CRON_DISABLED)
  }
}

function applyArchiveFailedConfig (config) {
  assert(!('archiveFailedAfterSeconds' in config) || config.archiveFailedAfterSeconds >= 1,
    'configuration assert: archiveFailedAfterSeconds must be at least every second and less than ')

  config.archiveFailedSeconds = config.archiveFailedAfterSeconds || config.archiveSeconds
  config.archiveFailedInterval = `${config.archiveFailedSeconds} seconds`

  // Do not emit warning twice
  if (config.archiveFailedSeconds < 60 && config.archiveSeconds >= 60) {
    emitWarning(WARNINGS.CRON_DISABLED)
  }
}

function applyRetentionConfig (config, defaults = {}) {
  assert(!('retentionSeconds' in config) || config.retentionSeconds >= 1,
    'configuration assert: retentionSeconds must be at least every second')

  assert(!('retentionMinutes' in config) || config.retentionMinutes >= 1,
    'configuration assert: retentionMinutes must be at least every minute')

  assert(!('retentionHours' in config) || config.retentionHours >= 1,
    'configuration assert: retentionHours must be at least every hour')

  assert(!('retentionDays' in config) || config.retentionDays >= 1,
    'configuration assert: retentionDays must be at least every day')

  const keepUntil = ('retentionDays' in config)
    ? `${config.retentionDays} days`
    : ('retentionHours' in config)
        ? `${config.retentionHours} hours`
        : ('retentionMinutes' in config)
            ? `${config.retentionMinutes} minutes`
            : ('retentionSeconds' in config)
                ? `${config.retentionSeconds} seconds`
                : null

  config.keepUntil = keepUntil
  config.keepUntilDefault = defaults?.keepUntil
}

function applyExpirationConfig (config, defaults = {}) {
  assert(!('expireInSeconds' in config) || config.expireInSeconds >= 1,
    'configuration assert: expireInSeconds must be at least every second')

  assert(!('expireInMinutes' in config) || config.expireInMinutes >= 1,
    'configuration assert: expireInMinutes must be at least every minute')

  assert(!('expireInHours' in config) || config.expireInHours >= 1,
    'configuration assert: expireInHours must be at least every hour')

  const expireIn = ('expireInHours' in config)
    ? config.expireInHours * 60 * 60
    : ('expireInMinutes' in config)
        ? config.expireInMinutes * 60
        : ('expireInSeconds' in config)
            ? config.expireInSeconds
            : null

  assert(!expireIn || expireIn / 60 / 60 < POLICY.MAX_EXPIRATION_HOURS, `configuration assert: expiration cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)

  config.expireIn = expireIn
  config.expireInDefault = defaults?.expireIn
}

function applyRetryConfig (config, defaults) {
  assert(!('retryDelay' in config) || (Number.isInteger(config.retryDelay) && config.retryDelay >= 0), 'retryDelay must be an integer >= 0')
  assert(!('retryLimit' in config) || (Number.isInteger(config.retryLimit) && config.retryLimit >= 0), 'retryLimit must be an integer >= 0')
  assert(!('retryBackoff' in config) || (config.retryBackoff === true || config.retryBackoff === false), 'retryBackoff must be either true or false')

  config.retryDelayDefault = defaults?.retryDelay
  config.retryLimitDefault = defaults?.retryLimit
  config.retryBackoffDefault = defaults?.retryBackoff
}

function applyPollingInterval (config, defaults) {
  assert(!('pollingIntervalSeconds' in config) || config.pollingIntervalSeconds >= POLICY.MIN_POLLING_INTERVAL_MS / 1000,
    `configuration assert: pollingIntervalSeconds must be at least every ${POLICY.MIN_POLLING_INTERVAL_MS}ms`)

  config.pollingInterval = ('pollingIntervalSeconds' in config)
    ? config.pollingIntervalSeconds * 1000
    : defaults?.pollingInterval || 2000
}

function applyMaintenanceConfig (config) {
  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  assert(!('maintenanceIntervalMinutes' in config) || config.maintenanceIntervalMinutes >= 1,
    'configuration assert: maintenanceIntervalMinutes must be at least every minute')

  config.maintenanceIntervalSeconds = ('maintenanceIntervalMinutes' in config)
    ? config.maintenanceIntervalMinutes * 60
    : ('maintenanceIntervalSeconds' in config)
        ? config.maintenanceIntervalSeconds
        : 120

  assert(config.maintenanceIntervalSeconds / 60 / 60 < POLICY.MAX_EXPIRATION_HOURS,
    `configuration assert: maintenance interval cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)
}

function applyDeleteConfig (config) {
  assert(!('deleteAfterSeconds' in config) || config.deleteAfterSeconds >= 1,
    'configuration assert: deleteAfterSeconds must be at least every second')

  assert(!('deleteAfterMinutes' in config) || config.deleteAfterMinutes >= 1,
    'configuration assert: deleteAfterMinutes must be at least every minute')

  assert(!('deleteAfterHours' in config) || config.deleteAfterHours >= 1,
    'configuration assert: deleteAfterHours must be at least every hour')

  assert(!('deleteAfterDays' in config) || config.deleteAfterDays >= 1,
    'configuration assert: deleteAfterDays must be at least every day')

  const deleteAfter = ('deleteAfterDays' in config)
    ? `${config.deleteAfterDays} days`
    : ('deleteAfterHours' in config)
        ? `${config.deleteAfterHours} hours`
        : ('deleteAfterMinutes' in config)
            ? `${config.deleteAfterMinutes} minutes`
            : ('deleteAfterSeconds' in config)
                ? `${config.deleteAfterSeconds} seconds`
                : '7 days'

  config.deleteAfter = deleteAfter
}

function applyMonitoringConfig (config) {
  assert(!('monitorStateIntervalSeconds' in config) || config.monitorStateIntervalSeconds >= 1,
    'configuration assert: monitorStateIntervalSeconds must be at least every second')

  assert(!('monitorStateIntervalMinutes' in config) || config.monitorStateIntervalMinutes >= 1,
    'configuration assert: monitorStateIntervalMinutes must be at least every minute')

  config.monitorStateIntervalSeconds =
    ('monitorStateIntervalMinutes' in config)
      ? config.monitorStateIntervalMinutes * 60
      : ('monitorStateIntervalSeconds' in config)
          ? config.monitorStateIntervalSeconds
          : null

  if (config.monitorStateIntervalSeconds) {
    assert(config.monitorStateIntervalSeconds / 60 / 60 < POLICY.MAX_EXPIRATION_HOURS,
      `configuration assert: state monitoring interval cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)
  }

  const TEN_MINUTES_IN_SECONDS = 600

  assert(!('clockMonitorIntervalSeconds' in config) || (config.clockMonitorIntervalSeconds >= 1 && config.clockMonitorIntervalSeconds <= TEN_MINUTES_IN_SECONDS),
    'configuration assert: clockMonitorIntervalSeconds must be between 1 second and 10 minutes')

  assert(!('clockMonitorIntervalMinutes' in config) || (config.clockMonitorIntervalMinutes >= 1 && config.clockMonitorIntervalMinutes <= 10),
    'configuration assert: clockMonitorIntervalMinutes must be between 1 and 10')

  config.clockMonitorIntervalSeconds =
    ('clockMonitorIntervalMinutes' in config)
      ? config.clockMonitorIntervalMinutes * 60
      : ('clockMonitorIntervalSeconds' in config)
          ? config.clockMonitorIntervalSeconds
          : TEN_MINUTES_IN_SECONDS

  assert(!('cronMonitorIntervalSeconds' in config) || (config.cronMonitorIntervalSeconds >= 1 && config.cronMonitorIntervalSeconds <= 45),
    'configuration assert: cronMonitorIntervalSeconds must be between 1 and 45 seconds')

  config.cronMonitorIntervalSeconds =
    ('cronMonitorIntervalSeconds' in config)
      ? config.cronMonitorIntervalSeconds
      : 30

  assert(!('cronWorkerIntervalSeconds' in config) || (config.cronWorkerIntervalSeconds >= 1 && config.cronWorkerIntervalSeconds <= 45),
    'configuration assert: cronWorkerIntervalSeconds must be between 1 and 45 seconds')

  config.cronWorkerIntervalSeconds =
    ('cronWorkerIntervalSeconds' in config)
      ? config.cronWorkerIntervalSeconds
      : 5
}

function warnClockSkew (message) {
  emitWarning(WARNINGS.CLOCK_SKEW, message, { force: true })
}

function emitWarning (warning, message, options = {}) {
  const { force } = options

  if (force || !warning.warned) {
    warning.warned = true
    message = `${warning.message} ${message || ''}`
    process.emitWarning(message, warning.type, warning.code)
  }
}
