/**
 *   Wechaty - https://github.com/chatie/wechaty
 *
 *   @copyright 2016-2017 Huan LI <zixia@zixia.net>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
import { EventEmitter } from 'events'
import * as path        from 'path'
import {
  Browser,
  Cookie,
  Dialog,
  launch,
  Page,
}                       from 'puppeteer'
import { parseString }  from 'xml2js'

/* tslint:disable:no-var-requires */
const retryPromise  = require('retry-promise').default

import { log }        from '../config'
import Profile        from '../profile'

import {
  MediaData,
  MsgRawObj,
}                     from './schema'

export interface InjectResult {
  code:    number,
  message: string,
}

export class Bridge extends EventEmitter {
  private browser: Browser
  private page:    Page

  constructor(
    public profile: Profile,
  ) {
    super()
    log.verbose('PuppetWebBridge', 'constructor()')
  }

  public async init(): Promise<void> {
    log.verbose('PuppetWebBridge', 'init()')

    try {
      this.browser = await launch({
        // ignoreHTTPSErrors: true,
        headless:          true,
        // args: [
        //   '--allow-insecure-localhost',
        // ],
      })

      const version = await this.browser.version()
      log.verbose('PUppetWebBridge', 'init() browser version: %s', version)

      const cookieList = this.profile.get('cookies') as Cookie[]
      if (cookieList.length) {
        await this.page.setCookie(...cookieList)
      }
      const domain = this.cookieDomain(cookieList)

      this.page = await this.browser.newPage()
      this.page.goto(domain, {
        waitUntil: 'load',  // https://github.com/GoogleChrome/puppeteer/issues/805
      })

      await this.page.exposeFunction('emit', this.emit.bind(this))

      const onDialog = (dialog: Dialog) => {
        log.warn('PuppetWebBridge', 'init() page.on(dialog) type:%s message:%s',
        dialog.type, dialog.message())
        dialog.dismiss()
        .catch(e => log.error('PuppetWebBridge', 'init() dialog.dismiss() reject: %s', e))
        this.emit('error', new Error(dialog.message()))
      }
      this.page.on('dialog', onDialog)

      await this.inject()
    } catch (e) {
      log.silly('PuppetWebBridge', 'init() exception: %s', e && e.message || e)
      throw e
    }
  }

  public async inject(): Promise<any> {
    log.verbose('PuppetWebBridge', 'inject()')

    try {
      let retObj = await this.page.injectFile(path.join(
        __dirname,
        'wechaty-bro.js',
      )) as any as InjectResult

      if (retObj && /^(2|3)/.test(retObj.code.toString())) {   // HTTP Code 2XX & 3XX
        log.silly('PuppetWebBridge', 'inject() eval(Wechaty) return code[%d] message[%s]',
                                      retObj.code, retObj.message)
      } else {                                    // HTTP Code 4XX & 5XX
        throw new Error('execute injectio error: ' + retObj.code + ', ' + retObj.message)
      }

      retObj = await this.proxyWechaty('init')
      if (retObj && /^(2|3)/.test(retObj.code.toString())) {   // HTTP Code 2XX & 3XX
        log.silly('PuppetWebBridge', 'inject() Wechaty.init() return code[%d] message[%s]'
          , retObj.code, retObj.message)
      } else {                                    // HTTP Code 4XX & 5XX
        throw new Error('execute proxyWechaty(init) error: ' + retObj.code + ', ' + retObj.message)
      }

      const r = await this.ding('inject()')
      if (r !== 'inject()') {
        throw new Error('fail to get right return from call ding()')
      }
      log.silly('PuppetWebBridge', 'inject() ding success')

      return true

    } catch (e) {
      log.verbose('PuppetWebBridge', 'inject() exception: %s. stack: %s', e.message, e.stack)
      throw e
    }
  }

  // public getInjectio(): string {
  //   log.verbose('PuppetWebBridge', 'getInjectio()')

  //   const fs = require('fs')
  //   const path = require('path')

  //   /**
  //    * Do not insert `return` in front of the code.
  //    * because the new line `\n` will cause return nothing at all
  //    */
  //   const code = 'injectioReturnValue = '
  //             + fs.readFileSync(
  //               path.join(__dirname, 'wechaty-bro.js'),
  //               'utf8',
  //             )
  //             + '; return injectioReturnValue'
  //   return code.replace(/[\n\s]/, ' ')
  // }

  public logout(): Promise<any> {
    log.verbose('PuppetWebBridge', 'quit()')
    return this.proxyWechaty('logout')
    .catch(e => {
      log.error('PuppetWebBridge', 'logout() exception: %s', e.message)
      throw e
    })
  }

  public quit(): Promise<void> {
    log.verbose('PuppetWebBridge', 'quit()')
    return this.proxyWechaty('quit').then(async () => {
      await this.page.close()
      await this.browser.close()
      log.silly('PuppetWebBridge', 'quit() page&browser closed.')
    }).catch(e => {
      log.warn('PuppetWebBridge', 'quit() exception: %s', e && e.message || e)
      // throw e
      /* fail safe */
    })

  }

  public async getUserName(): Promise<string> {
    log.verbose('PuppetWebBridge', 'getUserName()')

    try {
      const userName = await this.proxyWechaty('getUserName')

      return userName

    } catch (e) {
      log.error('PuppetWebBridge', 'getUserName() exception: %s', e.message)
      throw e
    }
  }

  public async contactRemark(contactId: string, remark: string|null): Promise<boolean> {
    try {
      return await this.proxyWechaty('contactRemark', contactId, remark)
    } catch (e) {
      log.verbose('PuppetWebBridge', 'contactRemark() exception: %s', e.message)
      // Issue #509 return false instead of throw when contact is not a friend.
      // throw e
      log.warn('PuppetWebBridge', 'contactRemark() does not work on contact is not a friend')
      return false
    }
  }

  public async contactFind(filterFunc: string): Promise<string[]> {
    try {
      return await this.proxyWechaty('contactFind', filterFunc)
    } catch (e) {
      log.error('PuppetWebBridge', 'contactFind() exception: %s', e.message)
      throw e
    }
  }

  public roomFind(filterFunc: string): Promise<string[]> {
    return this.proxyWechaty('roomFind', filterFunc)
                .catch(e => {
                  log.error('PuppetWebBridge', 'roomFind() exception: %s', e.message)
                  throw e
                })
  }

  public roomDelMember(roomId, contactId): Promise<number> {
    if (!roomId || !contactId) {
      throw new Error('no roomId or contactId')
    }

    return this.proxyWechaty('roomDelMember', roomId, contactId)
                .catch(e => {
                  log.error('PuppetWebBridge', 'roomDelMember(%s, %s) exception: %s', roomId, contactId, e.message)
                  throw e
                })
  }

  public async roomAddMember(roomId, contactId): Promise<number> {
    log.verbose('PuppetWebBridge', 'roomAddMember(%s, %s)', roomId, contactId)

    if (!roomId || !contactId) {
      throw new Error('no roomId or contactId')
    }
    try {
      return await this.proxyWechaty('roomAddMember', roomId, contactId)
    } catch (e) {
      log.error('PuppetWebBridge', 'roomAddMember(%s, %s) exception: %s', roomId, contactId, e.message)
      throw e
    }
  }

  public roomModTopic(roomId, topic): Promise<string> {
    if (!roomId) {
      throw new Error('no roomId')
    }

    return this.proxyWechaty('roomModTopic', roomId, topic)
                .then(_ => topic)
                .catch(e => {
                  log.error('PuppetWebBridge', 'roomModTopic(%s, %s) exception: %s', roomId, topic, e.message)
                  throw e
                })
  }

  public async roomCreate(contactIdList: string[], topic?: string): Promise<string> {
    if (!contactIdList || !Array.isArray(contactIdList)) {
      throw new Error('no valid contactIdList')
    }

    try {
      const roomId = await this.proxyWechaty('roomCreate', contactIdList, topic)
      if (typeof roomId === 'object') {
        // It is a Error Object send back by callback in browser(WechatyBro)
        throw roomId
      }
      return roomId
    } catch (e) {
      log.error('PuppetWebBridge', 'roomCreate(%s) exception: %s', contactIdList, e.message)
      throw e
    }
  }

  public async verifyUserRequest(contactId, hello): Promise<boolean> {
    log.verbose('PuppetWebBridge', 'verifyUserRequest(%s, %s)', contactId, hello)

    if (!contactId) {
      throw new Error('no valid contactId')
    }
    try {
      return await this.proxyWechaty('verifyUserRequest', contactId, hello)
    } catch (e) {
      log.error('PuppetWebBridge', 'verifyUserRequest(%s, %s) exception: %s', contactId, hello, e.message)
      throw e
    }
  }

  public async verifyUserOk(contactId, ticket): Promise<boolean> {
    log.verbose('PuppetWebBridge', 'verifyUserOk(%s, %s)', contactId, ticket)

    if (!contactId || !ticket) {
      throw new Error('no valid contactId or ticket')
    }
    try {
      return await this.proxyWechaty('verifyUserOk', contactId, ticket)
    } catch (e) {
      log.error('PuppetWebBridge', 'verifyUserOk(%s, %s) exception: %s', contactId, ticket, e.message)
      throw e
    }
  }

  public async send(toUserName: string, content: string): Promise<boolean> {
    if (!toUserName) {
      throw new Error('UserName not found')
    }
    if (!content) {
      throw new Error('cannot say nothing')
    }

    return this.proxyWechaty('send', toUserName, content)
              .catch(e => {
                log.error('PuppetWebBridge', 'send() exception: %s', e.message)
                throw e
              })
  }

  public getMsgImg(id): Promise<string> {
    log.verbose('PuppetWebBridge', 'getMsgImg(%s)', id)

    return this.proxyWechaty('getMsgImg', id)
                .catch(e => {
                  log.silly('PuppetWebBridge', 'proxyWechaty(getMsgImg, %d) exception: %s', id, e.message)
                  throw e
                })
  }

  public getMsgEmoticon(id): Promise<string> {
    log.verbose('PuppetWebBridge', 'getMsgEmoticon(%s)', id)

    return this.proxyWechaty('getMsgEmoticon', id)
                .catch(e => {
                  log.silly('PuppetWebBridge', 'proxyWechaty(getMsgEmoticon, %d) exception: %s', id, e.message)
                  throw e
                })
  }

  public async getMsgVideo(id): Promise<string> {
    log.verbose('PuppetWebBridge', 'getMsgVideo(%s)', id)

    try {
      return await this.proxyWechaty('getMsgVideo', id)
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getMsgVideo, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getMsgVoice(id): Promise<string> {
    log.verbose('PuppetWebBridge', 'getMsgVoice(%s)', id)

    try {
      return await this.proxyWechaty('getMsgVoice', id)
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getMsgVoice, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public async getMsgPublicLinkImg(id): Promise<string> {
    log.verbose('PuppetWebBridge', 'getMsgPublicLinkImg(%s)', id)

    try {
      return await this.proxyWechaty('getMsgPublicLinkImg', id)
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getMsgPublicLinkImg, %d) exception: %s', id, e.message)
      throw e
    }
  }

  public getContact(id: string): Promise<string> {
    if (id !== id) { // NaN
      const err = new Error('NaN! where does it come from?')
      log.error('PuppetWebBridge', 'getContact(NaN): %s', err)
      return Promise.reject(err)
    }
    const max = 35
    const backoff = 500

    // max = (2*totalTime/backoff) ^ (1/2)
    // timeout = 11,250 for {max: 15, backoff: 100}
    // timeout = 45,000 for {max: 30, backoff: 100}
    // timeout = 30,6250 for {max: 35, backoff: 500}
    const timeout = max * (backoff * max) / 2

    return retryPromise({ max: max, backoff: backoff }, attempt => {
      log.silly('PuppetWebBridge', 'getContact() retryPromise: attampt %s/%s time for timeout %s'
        , attempt, max, timeout)

      return this.proxyWechaty('getContact', id)
      .then(r => {
        if (!r) {
          throw new Error('got empty return')
        }
        return r
      })
      .catch(e => {
        log.silly('PuppetWebBridge', 'proxyWechaty(getContact, %s) exception: %s', id, e.message)
        throw e
      })
    })
    .catch(e => {
      log.warn('PuppetWebBridge', 'retryPromise() getContact() finally FAIL: %s', e.message)
      throw e
    })
    /////////////////////////////////
  }

  public async getBaseRequest(): Promise<string> {
    log.verbose('PuppetWebBridge', 'getBaseRequest()')

    try {
      return await this.proxyWechaty('getBaseRequest')
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getBaseRequest) exception: %s', e.message)
      throw e
    }
  }

  public async getPassticket(): Promise<string> {
    log.verbose('PuppetWebBridge', 'getPassticket()')

    try {
      return await this.proxyWechaty('getPassticket')
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getPassticket) exception: %s', e.message)
      throw e
    }
  }

  public async getCheckUploadUrl(): Promise<string> {
    log.verbose('PuppetWebBridge', 'getCheckUploadUrl()')

    try {
      return await this.proxyWechaty('getCheckUploadUrl')
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getCheckUploadUrl) exception: %s', e.message)
      throw e
    }
  }

  public async getUploadMediaUrl(): Promise<string> {
    log.verbose('PuppetWebBridge', 'getUploadMediaUrl()')

    try {
      return await this.proxyWechaty('getUploadMediaUrl')
    } catch (e) {
      log.silly('PuppetWebBridge', 'proxyWechaty(getUploadMediaUrl) exception: %s', e.message)
      throw e
    }
  }

  public sendMedia(mediaData: MediaData): Promise<boolean> {
    if (!mediaData.ToUserName) {
      throw new Error('UserName not found')
    }
    if (!mediaData.MediaId) {
      throw new Error('cannot say nothing')
    }
    return this.proxyWechaty('sendMedia', mediaData)
              .catch(e => {
                log.error('PuppetWebBridge', 'sendMedia() exception: %s', e.message)
                throw e
              })
  }

  public forward(baseData: MsgRawObj, patchData: MsgRawObj): Promise<boolean> {
    if (!baseData.ToUserName) {
      throw new Error('UserName not found')
    }
    if (!patchData.MMActualContent && !patchData.MMSendContent && !patchData.Content) {
      throw new Error('cannot say nothing')
    }
    return this.proxyWechaty('forward', baseData, patchData)
              .catch(e => {
                log.error('PuppetWebBridge', 'forward() exception: %s', e.message)
                throw e
              })
  }

  /**
   * Proxy Call to Wechaty in Bridge
   */
  public async proxyWechaty(wechatyFunc, ...args): Promise<any> {
    log.verbose('PuppetWebBridge', 'proxyWechaty(%s, %s)',
                                    wechatyFunc,
                                    args
                                    ? args.join(', ')
                                    : '',
              )

    const argsEncoded = new Buffer(
      encodeURIComponent(
        JSON.stringify(args),
      ),
    ).toString('base64')
    // see: http://blog.sqrtthree.com/2015/08/29/utf8-to-b64/
    const argsDecoded = `JSON.parse(decodeURIComponent(window.atob('${argsEncoded}')))`

    const wechatyScript = `
      return WechatyBro
              .${wechatyFunc}
              .apply(
                undefined,
                ${argsDecoded},
              )
    `.replace(/[\n\s]+/, ' ')
    // log.silly('PuppetWebBridge', 'proxyWechaty(%s, ...args) %s', wechatyFunc, wechatyScript)
    // console.log('proxyWechaty wechatyFunc args[0]: ')
    // console.log(args[0])

    try {
      const noWechaty = await this.page.evaluate('typeof WechatyBro === "undefined"')
      if (noWechaty) {
        const e = new Error('there is no WechatyBro in browser(yet)')
        // this.puppet.browser.dead(e)
        throw e
      }
    } catch (e) {
      log.warn('PuppetWebBridge', 'proxyWechaty() noWechaty exception: %s', e.stack)
      throw e
    }

    /**
     * WechatyBro method named end with "Async", will be treated as a Async function
     */
    // let funcExecuter
    // if (/Async$/.test(wechatyFunc)) {
    //   funcExecuter = this.executeAsync.bind(this)
    // } else {
    //   funcExecuter = this.execute.bind(this)
    // }
    try {
      // let ret
      /**
       * Async functions name is start with `Async` in WechatyBro
       */
      // if (/Async$/.test(wechatyFunc)) {
      //   ret = await this.executeAsync(wechatyScript)
      // } else {
        // ret = await this.execute(wechatyScript)
      // }
      const ret = await this.page.evaluate(wechatyScript)
      return ret

    } catch (e) {
      log.verbose('PuppetWebBridge', 'proxyWechaty(%s, %s) ', wechatyFunc, args.join(', '))
      log.warn('PuppetWebBridge', 'proxyWechaty() exception: %s', e.message)
      throw e
    }
  }

  /**
   * call REAL browser excute for other methods
   */
  // public async execute(script, ...args): Promise<any> {
  //   log.silly('PuppetWebBridge', 'execute()')

  //   if (!this.puppet || !this.puppet.browser) {
  //     throw new Error('execute(): no puppet or no puppet.browser in bridge')
  //   }
  //   return this.puppet.browser.execute(script, ...args)
  //                             .catch(e => {
  //                               log.warn('PuppetWebBridge', 'execute() exception: %s', e.message)
  //                               throw e
  //                             })
  // }

  // private async executeAsync(script, ...args): Promise<any> {
  //   if (!this.puppet || !this.puppet.browser) {
  //     throw new Error('execute(): no puppet or no puppet.browser in bridge')
  //   }
  //   return this.puppet.browser.executeAsync(script, ...args)
  //                             .catch(e => {
  //                               log.warn('PuppetWebBridge', 'executeAsync() exception: %s', e.message)
  //                               throw e
  //                             })
  // }

  public ding(data): Promise<any> {
    log.verbose('PuppetWebBridge', 'ding(%s)', data)

    return this.proxyWechaty('ding', data)
                .catch(e => {
                  log.error('PuppetWebBridge', 'ding(%s) exception: %s', data, e.message)
                  throw e
                })
  }

  /**
   * <error>
   *  <ret>1203</ret>
   *  <message>当前登录环境异常。为了你的帐号安全，暂时不能登录web微信。你可以通过手机客户端或者windows微信登录。</message>
   * </error>
   */
  public async blockedMessageBody(): Promise<string | null> {
    log.silly('PuppetWebBridge', 'blockedMessageBody()')
    const text = await this.page.evaluate('return document.body.innerText')

    return new Promise<string | null>((resolve, reject) => {
      parseString(text, { explicitArray: false }, (err, obj) => {
        if (err) {
          return resolve(null)
        }
        if (!obj.error) {
          return resolve(null)
        }
        const code    = obj.error.code
        const message = obj.error.message
        if (code === 1203) {
          // <error>
          // <ret>1203</ret>
          // <message>当前登录环境异常。为了你的帐号安全，暂时不能登录web微信。你可以通过手机客户端或者windows微信登录。</message>
          // </error>
          return resolve(message)
        }
        return resolve(message) // other error message
      })
    })
  }

  // public async blockedMessageAlert(): Promise<string | null> {
  //   log.silly('PuppetWebBridge', 'blockedMessageAlert()')

  //   // const driver = this.puppet.browser.driver

  //   return new Promise<string | null>(async (resolve, reject) => {
  //     const alert = driver.switchTo().alert()
  //     alert.catch(() => resolve(null))
  //     alert.then(() => {
  //       alert.getText().then(resolve)
  //     })
  //   })
  // }

  // TODO: from Browser to Bridge
  public async clickSwitchAccount(): Promise<boolean> {
    log.verbose('PuppetWebBrowser', 'clickSwitchAccount()')

    try {
      const button = await this.page.$("//div[contains(@class,'association') and contains(@class,'show')]/a[@ng-click='qrcodeLogin()']")
      await button.click();
      // const button = await this.driver.driver.findElement(By.xpath(
      //   "//div[contains(@class,'association') and contains(@class,'show')]/a[@ng-click='qrcodeLogin()']"))
      // button.click()
      log.silly('PuppetWebBrowser', 'clickSwitchAccount() clicked!')
      return true
    } catch (e) {
      log.silly('PuppetWebBrowser', 'clickSwitchAccount() button not found')
      return false
    }
  }

  public async hostname(): Promise<string | null> {
    log.verbose('PuppetWebBridge', 'hostname()')
    const hostname = await this.page.evaluate('location.hostname')
    log.silly('PuppetWebBridge', 'hostname() got %s', hostname)
    return hostname
  }

  public cookies(cookieList: Cookie[]): void
  public cookies(): Cookie[]

  public cookies(cookieList?: Cookie[]): void | Cookie[] {
    if (cookieList) {
      this.page.setCookie(...cookieList)
      .catch(err => {
        log.error('PuppetWebBridge', 'cookies(%s) reject: %s', cookieList, err)
        this.emit('error', err)
      })
      return
    } else {
      // FIXME: puppeteer typing bug
      cookieList = this.page.cookies() as any as Cookie[]
      return cookieList
    }
  }

  /**
   * name
   */
  public cookieDomain(cookieList: Cookie[]): string {
    log.verbose('PuppetWebBridge', 'cookieDomain(%s)', cookieList)

    const DEFAULT_HOSTNAME = 'wx.qq.com'

    if (!cookieList || cookieList.length === 0) {
      log.silly('PuppetWebBridge', 'cookieDomain() no cookie, return default hostname')
      return DEFAULT_HOSTNAME
    }

    const wxCookieList = cookieList.filter(c => /^webwx_auth_ticket|webwxuvid$/.test(c.name))
    if (!wxCookieList.length) {
      log.silly('PuppetWebBridge', 'cookieDomain() no valid cookie, return default hostname')
      return DEFAULT_HOSTNAME
    }
    let domain = wxCookieList[0].domain
    if (!domain) {
      log.silly('PuppetWebBridge', 'cookieDomain() no valid domain in cookies, return default hostname')
      return DEFAULT_HOSTNAME
    }

    domain = domain.slice(1)

    if (domain === 'wechat.com') {
      domain = 'web.wechat.com'
    }
    log.silly('PuppetWebBridge', 'cookieDomain() got %s', domain)

    return domain
  }

  public async reload(): Promise<void> {
    await this.page.reload()
    return
  }

  public async evaluate(...args: any[]): Promise<string> {
    return await this.page.evaluate.apply(this.page, args)
  }
}

export {
  Cookie,
}
export default Bridge
