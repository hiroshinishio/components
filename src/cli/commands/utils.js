/*
 * Serverless Components: Utilities
 */

const args = require('minimist')(process.argv.slice(2))
const path = require('path')
const os = require('os')
const {
  readConfigFile,
  writeConfigFile,
  createAccessKeyForTenant,
  refreshToken,
  listTenants
} = require('@serverless/platform-sdk')

const { readdirSync, statSync } = require('fs')
const { join, basename } = require('path')

const { readFileSync } = require('fs')
const ini = require('ini')
const { fileExistsSync, loadInstanceConfig, resolveInputVariables } = require('../utils')

const getDefaultOrgName = async () => {
  const res = readConfigFile()

  if (!res.userId) {
    return null
  }

  let { defaultOrgName } = res.users[res.userId].dashboard

  // if defaultOrgName is not in RC file, fetch it from the platform
  if (!defaultOrgName) {
    await refreshToken()

    const userConfigFile = readConfigFile()

    const { username, dashboard } = userConfigFile.users[userConfigFile.userId]
    const { idToken } = dashboard
    const orgsList = await listTenants({ username, idToken })

    // filter by owner
    const filteredOrgsList = orgsList.filter((org) => org.role === 'owner')

    defaultOrgName = filteredOrgsList[0].orgName

    res.users[res.userId].dashboard.defaultOrgName = defaultOrgName

    writeConfigFile(res)
  }

  return defaultOrgName
}

/**
 * Load AWS credentials from the aws credentials file
 */
const loadAwsCredentials = () => {
  const awsCredsInEnv = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY

  if (awsCredsInEnv) {
    // exit if the user already has aws credentials in env or .env file
    return
  }

  // fetch the credentials file path
  const awsCredentialsPath =
    process.env.AWS_CREDENTIALS_PATH || path.resolve(os.homedir(), './.aws/credentials')

  const awsCredsFileExists = fileExistsSync(awsCredentialsPath)

  if (!awsCredsFileExists) {
    // exit if the user has no aws credentials file
    return
  }

  // read the credentials file
  const credentialsFile = readFileSync(awsCredentialsPath, 'utf8')

  // parse the credentials file
  const parsedCredentialsFile = ini.parse(credentialsFile)

  // get the configured profile
  const awsCredentialsProfile =
    process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || 'default'

  // get the credentials for that profile
  const credentials = parsedCredentialsFile[awsCredentialsProfile]

  // set the credentials in the env to pass it to the sdk
  process.env.AWS_ACCESS_KEY_ID = credentials.aws_access_key_id
  process.env.AWS_SECRET_ACCESS_KEY = credentials.aws_secret_access_key

  return
}

/**
 * Load credentials from a ".env" or ".env.[stage]" file
 * @param {*} stage
 */

const loadInstanceCredentials = () => {
  // load aws credentials if found
  loadAwsCredentials()

  // Known Provider Environment Variables and their SDK configuration properties
  const providers = {}

  // AWS
  providers.aws = {}
  providers.aws.AWS_ACCESS_KEY_ID = 'accessKeyId'
  providers.aws.AWS_SECRET_ACCESS_KEY = 'secretAccessKey'
  providers.aws.AWS_REGION = 'region'

  // Google
  providers.google = {}
  providers.google.GOOGLE_APPLICATION_CREDENTIALS = 'applicationCredentials'
  providers.google.GOOGLE_PROJECT_ID = 'projectId'
  providers.google.GOOGLE_CLIENT_EMAIL = 'clientEmail'
  providers.google.GOOGLE_PRIVATE_KEY = 'privateKey'

  // Kubernetes
  providers.kubernetes = {}
  providers.kubernetes.KUBERNETES_ENDPOINT = 'endpoint'
  providers.kubernetes.KUBERNETES_PORT = 'port'
  providers.kubernetes.KUBERNETES_SERVICE_ACCOUNT_TOKEN = 'serviceAccountToken'
  providers.kubernetes.KUBERNETES_SKIP_TLS_VERIFY = 'skipTlsVerify'

  // Docker
  providers.docker = {}
  providers.docker.DOCKER_USERNAME = 'username'
  providers.docker.DOCKER_PASSWORD = 'password'
  providers.docker.DOCKER_AUTH = 'auth'

  const credentials = {}

  for (const provider in providers) {
    const providerEnvVars = providers[provider]
    for (const providerEnvVar in providerEnvVars) {
      if (!credentials[provider]) {
        credentials[provider] = {}
      }
      // Proper environment variables override what's in the .env file
      if (process.env.hasOwnProperty(providerEnvVar)) {
        credentials[provider][providerEnvVars[providerEnvVar]] = process.env[providerEnvVar]
      }
      continue
    }
  }

  return credentials
}

/**
 * Reads a serverless instance config file in a given directory path
 * @param {*} directoryPath
 */
const loadVendorInstanceConfig = async (directoryPath) => {
  const instanceFile = loadInstanceConfig(directoryPath)

  if (!instanceFile) {
    throw new Error(`serverless config file was not found`)
  }

  if (!instanceFile.name) {
    throw new Error(`Missing "name" property in serverless.yml`)
  }

  if (!instanceFile.component) {
    throw new Error(`Missing "component" property in serverless.yml`)
  }

  // if stage flag provided, overwrite
  if (args.stage) {
    instanceFile.stage = args.stage
  }

  // if org flag provided, overwrite
  if (args.org) {
    instanceFile.org = args.org
  }

  if (!instanceFile.org) {
    instanceFile.org = await getDefaultOrgName()
  }

  if (!instanceFile.org) {
    throw new Error(`Missing "org" property in serverless.yml`)
  }

  // if app flag provided, overwrite
  if (args.app) {
    instanceFile.app = args.app
  }

  if (instanceFile.inputs) {
    // load credentials to process .env files before resolving env variables
    await loadInstanceCredentials(instanceFile.stage)
    instanceFile.inputs = resolveInputVariables(instanceFile.inputs)
  }

  return instanceFile
}

/**
 * Check whether the user is logged in
 */
const isLoggedIn = () => {
  const userConfigFile = readConfigFile()
  // If userId is null, they are not logged in.  They also might be a new user.
  if (!userConfigFile.userId) {
    return false
  }
  if (!userConfigFile.users[userConfigFile.userId]) {
    return false
  }
  return true
}

/**
 * Gets the logged in user's token id, or access key if its in env
 */
const getAccessKey = async () => {
  // if access key in env, use that for CI/CD
  if (process.env.SERVERLESS_ACCESS_KEY) {
    return process.env.SERVERLESS_ACCESS_KEY
  }

  if (!isLoggedIn()) {
    return null
  }

  // refresh token if it's expired.
  // this platform-sdk method returns immediately if the idToken did not expire
  // if it did expire, it'll refresh it and update the config file
  await refreshToken()

  // read config file from user machine
  const userConfigFile = readConfigFile()

  // Verify config file and that the user is logged in
  if (!userConfigFile || !userConfigFile.users || !userConfigFile.users[userConfigFile.userId]) {
    return null
  }

  const user = userConfigFile.users[userConfigFile.userId]

  return user.dashboard.idToken
}

/**
 * Gets or creates an access key based on org
 * @param {*} org
 */
const getOrCreateAccessKey = async (org) => {
  if (process.env.SERVERLESS_ACCESS_KEY) {
    return process.env.SERVERLESS_ACCESS_KEY
  }

  // read config file from the user machine
  const userConfigFile = readConfigFile()

  // Verify config file
  if (!userConfigFile || !userConfigFile.users || !userConfigFile.users[userConfigFile.userId]) {
    return null
  }

  const user = userConfigFile.users[userConfigFile.userId]

  if (!user.dashboard.accessKeys[org]) {
    // create access key and save it
    const accessKey = await createAccessKeyForTenant(org)
    userConfigFile.users[userConfigFile.userId].dashboard.accessKeys[org] = accessKey
    writeConfigFile(userConfigFile)
    return accessKey
  }

  // return the access key for the specified org
  // return user.dashboard.accessKeys[org]
  return user.dashboard.idToken
}

const getTemplate = async (root) => {
  const directories = readdirSync(root).filter((f) => statSync(join(root, f)).isDirectory())

  const template = {
    name: basename(process.cwd()),
    org: null,
    app: null, // all components must explicitly set app property
    stage: null
  }

  let componentDirectoryFound = false
  for (const directory of directories) {
    const directoryPath = join(root, directory)

    const instanceYml = loadInstanceConfig(directoryPath)

    if (instanceYml) {
      componentDirectoryFound = true
      const instanceYaml = await loadVendorInstanceConfig(directoryPath)

      if (template.org !== null && template.org !== instanceYaml.org) {
        throw new Error('Attempting to deploy multiple instances to multiple orgs')
      }

      if (template.app !== null && template.app !== instanceYaml.app) {
        throw new Error('Attempting to deploy multiple instances to multiple apps')
      }

      if (template.stage !== null && template.stage !== instanceYaml.stage) {
        throw new Error('Attempting to deploy multiple instances to multiple stages')
      }

      template.org = instanceYaml.org // eslint-disable-line
      template.app = instanceYaml.app // eslint-disable-line
      template.stage = instanceYaml.stage // eslint-disable-line

      // update paths in inputs
      if (instanceYaml.inputs.src) {
        if (typeof instanceYaml.inputs.src === 'string') {
          instanceYaml.inputs.src = join(directoryPath, instanceYaml.inputs.src)
        } else if (typeof instanceYaml.inputs.src === 'object') {
          if (instanceYaml.inputs.src.src) {
            instanceYaml.inputs.src.src = join(directoryPath, instanceYaml.inputs.src.src)
          }

          if (instanceYaml.inputs.src.dist) {
            instanceYaml.inputs.src.dist = join(directoryPath, instanceYaml.inputs.src.dist)
          }
        }
      }

      template[instanceYml.name] = instanceYaml
    }
  }

  return componentDirectoryFound ? template : null
}

module.exports = {
  loadInstanceConfig: loadVendorInstanceConfig,
  getTemplate,
  loadInstanceCredentials,
  getOrCreateAccessKey,
  getAccessKey,
  isLoggedIn,
  getDefaultOrgName
}