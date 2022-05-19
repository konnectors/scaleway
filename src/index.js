process.env.SENTRY_DNS =
  process.env.SENTRY_DNS ||
  'https://1c8be841977f40f992a22e4f26a225e4:e91462663958491d9540f2ffaa60dcd4@sentry.cozycloud.cc/52'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  errors,
  solveCaptcha
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
  const jwtResponse = await authenticate(fields.login, fields.password)
  const token = jwtResponse.auth.jwt_key
  log('info', 'Successfully logged in, token created')
  try {
    log('info', 'Fetching the list of documents')
    log('info', `With the token ${token.slice(0, 9)}...`)
    const userInfos = await request({
      uri: `https://api.scaleway.com/account/v1/users/${jwtResponse.jwt.issuer}`,
      headers: {
        'X-Session-Token': token,
        'User-Agent':
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
      }
    })

    const organizationId = userInfos.user.organizations[0].id
    const { invoices } = await request({
      uri: `${baseUrl}&organization_id=${organizationId}`,
      headers: {
        'X-Session-Token': token,
        'User-Agent':
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
      }
    })
    log('info', 'Parsing list of documents')
    const documents = invoices
      .filter(invoice => invoice.state === 'paid')
      .map(
        ({
          organization_id,
          start_date,
          id,
          total_taxed: amount,
          currency
        }) => ({
          fileurl: `https://billing.scaleway.com/invoices/${organization_id}/${start_date}/${id}?format=pdf`,
          requestOptions: {
            headers: {
              'X-Session-Token': token,
              'User-Agent':
                'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
            }
          },
          filename: `${moment(new Date(start_date)).format(
            'YYYY-MM-DD'
          )}_${amount}_${currency}.pdf`,
          vendor: 'scaleway',
          date: new Date(start_date),
          amount: parseFloat(amount),
          currency: currency
        })
      )

    log('debug', documents)

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
      'X-Session-Token': token,
      'User-Agent':
        'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
    }
  })
  log('info', `token deleted: ${JSON.stringify(response)}`)
}

async function authenticate(email, password) {
  log('debug', 'get in authenticate')
  try {
    const jwtResponse = await request({
      method: 'POST',
      uri: 'https://api.scaleway.com/account/v1/jwt',
      body: {
        email,
        password,
        renewable: false
      },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
      }
    })
    return jwtResponse
  } catch (err) {
    if (
      err.message ===
      '401 - {"type":"captcha_required","message":"Missing Captcha"}'
    ) {
      const gRecaptcha = await solveCaptcha({
        websiteKey: '6LfvYbQUAAAAACK597rFdAMTYinNYOf_zbiuvMWA',
        websiteURL: 'https://console.scaleway.com/login-password'
      })
      const jwtResponse = await request({
        method: 'POST',
        uri: 'https://api.scaleway.com/account/v1/jwt',
        body: {
          captcha: gRecaptcha,
          email,
          password,
          renewable: false
        },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
        }
      })
      return jwtResponse
    } else {
      log('error', err.message)
      throw errors.LOGIN_FAILED
    }
  }
}
