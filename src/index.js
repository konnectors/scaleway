process.env.SENTRY_DNS =
  process.env.SENTRY_DNS ||
  'https://1c8be841977f40f992a22e4f26a225e4:e91462663958491d9540f2ffaa60dcd4@sentry.cozycloud.cc/52'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  errors
} = require('cozy-konnector-libs')
const moment = require('moment')
moment.locale('fr')
const request = requestFactory({
  cheerio: false,
  json: true
})

const baseUrl = 'https://billing.scaleway.com/invoices?page=1&per_page=12'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const token = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in, token created')
  try {
    log('info', 'Fetching the list of documents')
    log('info', `With the token ${token.slice(0, 9)}...`)
    const { invoices } = await request({
      uri: baseUrl,
      headers: {
        'X-Auth-Token': token
      }
    })
    log('info', 'Parsing list of documents')
    const documents = invoices.filter(invoice => invoice.state === "paid").map(
      ({
        organization_id,
        start_date,
        id,
        total_undiscounted: amount,
        currency
      }) => ({
        fileurl: `https://billing.scaleway.com/invoices/${organization_id}/${start_date}/${id}?format=pdf&x-auth-token=${token}`,
        filename: `${moment(new Date(start_date)).format(
          'YYYY-MM-DD'
        )}_${amount}_${currency}.pdf`,
        vendor: 'scaleway',
        date: new Date(start_date),
        amount: parseFloat(amount),
        currency: currency
      })
    )

    // here we use the saveBills function even if what we fetch are not bills, but this is the most
    // common case in connectors
    log('info', 'Saving data to Cozy')
    await saveBills(documents, fields.folderPath, {
      // this is a bank identifier which will be used to link bills to bank operations. These
      // identifiers should be at least a word found in the title of a bank operation related to this
      // bill. It is not case sensitive.
      identifiers: ['scaleway']
    })
  } finally {
    clearToken(token)
  }
}

async function clearToken(token) {
  const response = await request({
    method: 'DELETE',
    uri: `https://account.scaleway.com/tokens/${token}`,
    headers: {
      'X-Auth-Token': token
    }
  })
  log('info', `token deleted: ${JSON.stringify(response)}`)
}

async function authenticate(email, password) {
  try {
    const {
      token: { id }
    } = await request({
      method: 'POST',
      uri: 'https://account.scaleway.com/tokens',
      body: {
        email,
        password
      }
    })
    return id
  } catch (err) {
    log('error', err.message)
    throw errors.LOGIN_FAILED
  }
}
