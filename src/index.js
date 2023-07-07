process.env.SENTRY_DNS =
  process.env.SENTRY_DNS ||
  'https://f5e851d01e0f4ce3b19a13246b2af7cb@errors.cozycloud.cc/43'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  errors,
  solveCaptcha,
  cozyClient
} = require('cozy-konnector-libs')

const dayjs = require('dayjs')
dayjs.locale('fr')

const request = requestFactory({
  cheerio: false,
  json: true
})

const models = cozyClient.new.models
const { Qualification } = models.document
const userAgent =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0'
const baseUrl = 'https://api.scaleway.com/billing/v1/invoices'

const currencySymbols = {
  EUR: '€',
  USD: '$'
}

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const jwtResponse = await authenticate.bind(this)(
    fields.login,
    fields.password,
    fields.twoFACode
  )
  const token = jwtResponse.auth.jwt_key
  const id_jti = jwtResponse.jwt.jti
  log('info', 'Successfully logged in, token created')
  try {
    log('info', 'Fetching the list of documents')
    log('info', `With the token ${token.slice(0, 9)}...`)
    const userInfos = await request({
      uri: `https://api.scaleway.com/account/v2/users/${jwtResponse.jwt.issuer}`,
      headers: {
        'X-Session-Token': token,
        'User-Agent': userAgent
      }
    })

    const organizationId = userInfos.organizations[0].id
    const { invoices } = await request({
      uri: `${baseUrl}?organization_id=${organizationId}`,
      headers: {
        'X-Session-Token': token,
        'User-Agent': userAgent
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
          requestOptions: {
            headers: {
              'X-Session-Token': token,
              'User-Agent': userAgent
            }
          },
          fileurl: `https://api.scaleway.com/billing/v1/invoices/${organization_id}/${start_date}/${id}?format=pdf`,
          filename: `${dayjs(new Date(start_date)).format(
            'YYYY-MM-DD'
          )}_${amount}${currencySymbols[currency] || '_' + currency}.pdf`,
          vendor: 'scaleway',
          date: new Date(start_date),
          amount: parseFloat(amount),
          currency: currency,
          fileAttributes: {
            metadata: {
              contentAuthor: 'scaleway.com',
              issueDate: new Date(),
              datetime: new Date(start_date),
              datetimeLabel: `issueDate`,
              carbonCopy: true,
              qualification: Qualification.getByLabel('web_service_invoice')
            }
          }
        })
      )

    // here we use the saveBills function even if what we fetch are not bills, but this is the most
    // common case in connectors
    log('info', 'Saving data to Cozy')
    await saveBills(documents, fields.folderPath, {
      // this is a bank identifier which will be used to link bills to bank operations. These
      // identifiers should be at least a word found in the title of a bank operation related to this
      // bill. It is not case sensitive.
      identifiers: ['scaleway.com'],
      fileIdAttributes: ['filename'],
      sourceAccount: fields.login,
      sourceAccountIdentifier: fields.login,
      contentType: 'application/pdf'
    })
  } finally {
    // this request returned undefind, maybe not working
    await clearToken(token, id_jti)
  }
}

async function clearToken(token, id_jti) {
  try {
    const response = await request({
      method: 'DELETE',
      uri: `https://api.scaleway.com/iam/v1alpha1/jwts/${id_jti}`,
      headers: {
        'x-session-token': token,
        'User-Agent': userAgent
      }
    })
    log('info', `token deleted: ${JSON.stringify(response)}`)
  } catch (err) {
    log('warn', `Cannot delete token properly : ${err}`)
  }
}

async function authenticate(email, password) {
  log('debug', `authenticate`)
  let requestBody = {
    email: email,
    password: password
  }
  try {
    const gRecaptcha = await solveCaptcha({
      websiteKey: '6LfvYbQUAAAAACK597rFdAMTYinNYOf_zbiuvMWA',
      websiteURL: 'https://console.scaleway.com/login-password'
    })
    requestBody['captcha'] = gRecaptcha
    const jwtResponse = await request({
      method: 'POST',
      uri: 'https://api.scaleway.com/account/v1/jwt',
      body: requestBody,
      headers: {
        'User-Agent': userAgent
      }
    })
    return jwtResponse
  } catch (err) {
    if (
      err.message.includes(
        '403 - {"type":"2FA_error","message":"Two-Factor authentication error"'
      )
    ) {
      log('info', 'getting in 2fa condition')
      const code = await this.waitForTwoFaCode({
        type: 'app_code'
      })
      requestBody['2FA_token'] = code
      const jwtResponse = await request({
        method: 'POST',
        uri: 'https://api.scaleway.com/account/v1/jwt',
        body: requestBody,
        headers: {
          'User-Agent': userAgent
        }
      })
      return jwtResponse
    } else if (
      err.message.includes('required passwordless auth for unknown ip')
    ) {
      log('warn', 'passwordless link need detected, erroring for now')
      log('error', err.message)
      throw errors.LOGIN_FAILED.MAGICLINK_NOT_IMPLEMENTED
    } else {
      log('error', err.message)
      throw errors.LOGIN_FAILED
    }
  }
}
