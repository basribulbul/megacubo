const Events = require('events'), parseRange = require('range-parser')
const zlib = require('zlib'), Writer = require('../write-queue/writer')
const StringDecoder = require('string_decoder').StringDecoder
const DownloadP2PHandler = require('./download-p2p')
const DownloadCacheMap = require('./download-cache')
const DownloadStreamHybrid = require('./stream-hybrid')

class Download extends Events {
   constructor(opts){
	   	super()
		this.startTime = global.time()
		this.opts = {
			p2p: false,
			p2pWaitMs: 2000,
			cacheTTL: 0,
			uid: parseInt(Math.random() * 10000000000000),
			debug: Download.debug || false,
			keepalive: false,
			maxAuthErrors: 2,
			maxAbortErrors: 2,
			redirectionLimit: 20,
			retries: 3,
			resume: true,
			compression: true,
			headers: {
				'accept': '*/*',
				'user-agent': global.config.get('user-agent') || global.config.get('default-user-agent'),
				'accept-language': this.defaultAcceptLanguage()
			},
			authErrorCodes: [401, 403],
			permanentErrorCodes: [-1, 400, 404, 405, 410, 521], // -1 == permanentErrorRegex matched
			permanentErrorRegex: new RegExp('(ENOTFOUND|ENODATA|ENETUNREACH|ECONNREFUSED|cannot resolve)', 'i'),
			timeout: null,
			followRedirect: true,
			acceptRanges: false, // Cloudflare may send invalid content-range when requesting inadvertedly with bytes=0-
			encoding: null
		}
		if(opts){
			if(opts.headers){
				opts.headers = Object.assign(this.opts.headers, opts.headers)
			}
			Object.assign(this.opts, opts)
		}
		this.currentURL = this.opts.url
		this.opts.headers['connection'] = this.opts.keepalive ? 'keep-alive' : 'close'
		if(this.opts.responseType && this.opts.responseType == 'json'){
			this.opts.headers['accept'] = 'application/json,text/*;q=0.99'
		}
		this.opts.headers['accept-encoding'] = 'identity'
		if(this.opts.compression){
			this.opts.headers['accept-encoding'] = 'gzip, deflate'
		}
		if(!this.opts.headers['vary']){
			this.opts.headers['vary'] = 'accept-ranges'
		}
		if(this.opts.events){
			Object.keys(this.opts.events).forEach(n => {
				this.on(n, this.opts.events[n])
			})
		}
		this.timings = {}
		this.buffer = []
		this.redirectLog = []
		this.redirectCount = 0
		this.retryCount = 0
		this.retryDelay = 150
		this.received = 0
		this.receivedUncompressed = 0
		this.isResponseCompressed = false
		this.receivingRange = false
		this.requestingRange = false
		this.headersSent = false
		this.contentLength = -1
		this.totalContentLength = -1
		this.errorCount = []
		this.errors = []
		this.authErrors = 0
		this.abortErrors = 0
		this.statusCode = 0
		this.ignoreBytes = 0
		this.connectCount = 0
		this.currentRequestError = ''
		this.currentResponse = null
		this.authURLPingAfter = 0
		this.responseSource = ''
		this.on('error', () => {}) // avoid uncaught exception, make error listening not mandatory
		if(typeof(this.opts.headers['range']) != 'undefined'){
			this.checkRequestingRange(this.opts.headers['range'])
		}
	}
	avoidKeepAlive(url){ // on some servers, the number of sockets increase indefinitely causing downloads to hang up after some time, doesn't seems that these sockets are really being reused
		const d = this.getDomain(url, true)
		if(Download.keepAliveDomainBlacklist.includes(d)){
			return true
		}
		return ['KHttpAgent', 'KHttpsAgent'].some(method => {
			return Object.keys(DownloadStreamHybrid.engines.http.keepAliveAgents[method].sockets).some(domain => {
				if(domain.indexOf(d) == -1) return
				if(DownloadStreamHybrid.engines.http.keepAliveAgents[method].sockets[domain] && DownloadStreamHybrid.engines.http.keepAliveAgents[method].sockets[domain].length == DownloadStreamHybrid.engines.http.keepAliveAgents[method].maxSockets){
					if(!DownloadStreamHybrid.engines.http.keepAliveAgents[method].freeSockets[domain] || !DownloadStreamHybrid.engines.http.keepAliveAgents[method].freeSockets[domain].length){
						Download.keepAliveDomainBlacklist.push(d)
						console.warn('Keep alive exhausted for '+ domain)
						return true
					}
				}
			})
		})
	}
	pingAuthURL(){
		const now = global.time()
		if(this.opts.authURL && now > this.authURLPingAfter){
			this.authURLPingAfter = now + 10
			Download.get({
				url: this.opts.authURL,
				timeout: 10,
				retry: 0,
				receiveLimit: 1,
				followRedirect: true
			}).catch(err => {
				console.error('pingAuthURL error: '+ String(err))
			})
		}
	}
	start(){
		if(!this.started && !this.ended && !this.destroyed){
			this.started = true
			if(!Download.p2p && Download.p2p !== 0 && global.uiReady && global.config.get('p2p')){
				Download.p2p = 0 // lock, zero means loading
				let srvConfig = {}	
				global.cloud.get('configure').then(c => srvConfig = c).catch(console.error).finally(() => {
					if((!srvConfig || !srvConfig['disable-p2p']) && !Download.p2p){
						console.warn('INIT P2P')
						global.uiReady(() => {
							Download.p2p = new DownloadP2PHandler(global.ui, Download.cache)
							const addr = srvConfig['p2p-signal-server'] || global.config.get('p2p-signal-server') || 'ws://signal.megacubo.net'
							const limit = srvConfig['p2p-peers-limit'] || global.config.get('p2p-peers-limit') || 8
							console.warn('INIT P2P', addr, limit)
							global.ui.once('init-p2p-failure', () => {
								Download.p2p = 0 // lock, set zero to skip P2P usage
							})
							global.ui.emit('init-p2p', addr, limit)
						})
					}
				})
			}
			if(global.osd && global.debugConns){
				let txt = this.opts.url.split('?')[0].split('/').pop()
				global.osd.show(txt, 'fas fa-download', 'down-'+ this.opts.uid, 'persistent')
				if(typeof(global.requests) == 'undefined') global.requests = {}
				global.requests[txt] = this
			}
			this.connect()
		}
	}
	ext(url){
		return String(url).split('?')[0].split('#')[0].split('.').pop().toLowerCase();        
	}
	getDomain(u, includePort){
		let d = u
		if(u && u.indexOf('//') != -1){
			d = u.split('//')[1].split('/')[0]
		}
		if(d.indexOf('@') != -1){
			d = d.split('@')[1]
		}
		if(d.indexOf(':') != -1 && !includePort) {
			d = d.split(':')[0]
		}
		return d
	}
	titleCaseHeaders(headers){
		const nheaders = {}
		Object.keys(headers).forEach(name => {
			let tname = name
			if(name.toLowerCase() == name){
				tname = name.replace(/([^\W_]+[^\s-]*) */g, function(txt) {
					return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
				})
			}
			nheaders[tname] = headers[name]
		})
		return nheaders
	}
	parseRange(range){
        let requestingRange
		const maxInt = Number.MAX_SAFE_INTEGER
		const ranges = parseRange(maxInt, range.replace('bytes ', 'bytes='))
		if (Array.isArray(ranges)) { // TODO: enable multi-ranging support
			requestingRange = ranges[0]
			if(requestingRange.end == '*'){ // remove dummy value
				delete requestingRange.end
			} else if(requestingRange.end >= (maxInt - 1)){ // remove dummy value
				delete requestingRange.end
			}
            return requestingRange
		}
	}
	checkRequestingRange(range){
		const ranges = this.parseRange(range)
		if (ranges && typeof(ranges.start) == 'number') { // TODO: enable multi-ranging support
			this.requestingRange = ranges
			if(this.requestingRange.end && this.requestingRange.end > 0){
				this.contentLength = (this.requestingRange.end - this.requestingRange.start) + 1
			}
			this.opts.headers['accept-encoding'] = 'identity' // don't handle decompression with ranging requests
		}
	}
	defaultAcceptLanguage(){
		if(global.lang){
			return global.lang.locale +'-'+ global.lang.countryCode.toUpperCase() +','+ global.lang.locale +';q=1,*;q=0.7'
		} else {
			return '*'
		}
	}
	parsePhases(timings){
		let keys = Object.keys(timings).filter(k => typeof(timings[k]) == 'number').sort((a, b) => timings[a] - timings[b])
		let phases = {}, base = timings.start || this.stream.startTime
		keys.slice(1).forEach((k, i) => {
			let pk = keys[i]
			phases[pk] = timings[k] - base
			base = timings[k]
		})
		return phases		
	}
	connect(){
		if(this.destroyed) return
		if(this.stream){
			console.error('Connect before destroyStream', traceback())
			this.destroyStream()
		}
		if(this.decompressor && this.opts.acceptRanges){
			// resume with byte ranging should not use gzip
			// if will not use ranging but redownload, why not keep using compression?
			const continueWithoutCompression = () => {
				this.isResponseCompressed = false
				this.decompressor = undefined
				this.decompressEnded = undefined
				this.received = this.receivedUncompressed
				this.contentLength = undefined
				this.totalContentLength = undefined
				this.opts.compression = false
				this.connect()
			}
			if(this.decompressEnded){
				continueWithoutCompression()
			} else {
				this.once('decompressed', () => {
					if(this.opts.debug){
						console.log('decompressor end')
					}
					continueWithoutCompression()
				})
				this.decompressor.flush()
				this.decompressor.end()
			}
			return
		}
		if(!Download.isNetworkConnected){
			this.endWithError('No internet connection')
			return
		}
		if(this.stream){
			console.error('Download error, stream already connected')
			return
		}
		if(this.currentRequestError){
			this.currentRequestError = ''
		}
		if(this.currentURL.substr(0, 2) == '//'){
			this.currentURL = 'http:'+ this.currentURL
		}
		if(!global.validateURL(this.currentURL)){
			this.endWithError('Invalid URL: '+ this.currentURL)
			return
		}
		if(this.continueTimer){
			clearTimeout(this.continueTimer)
		}
		const opts = {
			url: this.currentURL,
			uid: this.opts.uid // for DownloadStreamCache
		}
    	const requestHeaders = Object.assign({}, this.opts.headers)
		if(this.opts.keepalive && this.avoidKeepAlive(this.currentURL)){
			this.opts.keepalive = false
		}
		requestHeaders.connection = this.opts.keepalive ? 'keep-alive' : 'close'		
		if(this.ext(this.currentURL) == 'gz'){
			this.opts.acceptRanges = false
		}
    	if(this.opts.acceptRanges) { // should include even bytes=0-
			if(this.requestingRange){
				let range = 'bytes='
				range += (this.requestingRange.start + this.receivedUncompressed) + '-'
				if(this.requestingRange.end){
					range += this.requestingRange.end
				}
				requestHeaders.range = range // we dont know yet if the server support ranges, so check again on parseResponse
			} else {
				requestHeaders.range = 'bytes=' + this.receivedUncompressed + '-'
				requestHeaders['accept-encoding'] = 'identity' // do not resume with gzip
			}
		} else {
			if(this.received){ // here use received instead of receiveUncompressed
				this.ignoreBytes = this.received // ignore data already received on last connection so
			}
		}
		requestHeaders.host = this.getDomain(opts.url, true)
		const match = opts.url.match(new RegExp('//([^/]+:[^/]+)@'))
		if(match){
			requestHeaders.authorization = 'Basic '+ Buffer.from(match[1]).toString('base64')
		}
		opts.headers = requestHeaders
		opts.timeout = this.getTimeoutOptions()
		if(this.opts.debug) {
			console.log('>> Download request: '+ this.currentURL, this.connectCount, opts, this.received, JSON.stringify(opts.headers), this.requestingRange, this.opts.headers['range'], global.traceback())
		}
		this.connectCount++
		let redirected
		const stream = new DownloadStreamHybrid(opts, this.opts)
		stream.startTime = global.time() * 1000
		stream.once('response', response => {
			this.lastStatusCodeReceived = response.statusCode	
			this.lastHeadersReceived = response.headers
			redirected = this.checkRedirect(response)
			if(this.opts.debug){
				console.log('>> check redirect', redirected)
			}
			if(!redirected) {
				this.parseResponse(response)
			}
		})
		stream.on('error', this.errorCallback.bind(this))
		stream.once('end', () => {
			if(this.opts.debug){
				console.log('>> Stream finished', redirected)
			}
			if(!redirected){
				this.continue()
			}
		})
		this.stream = stream
	}
	reconnect(force){
		if(force || !this.received){
			this.destroyStream()
			this.continue()
		}
	}
	errorCallback(err){
		if(!this.destroyed && !this.ended){
			if(this.opts.debug){
				console.error('>> Download error', err, this.opts.url, global.traceback())
			}
			this.errors.push(String(err) || 'unknown request error')
			if(String(err).match(this.opts.permanentErrorRegex)){
				this.statusCode = -1
			}
			if(!this.currentRequestError){
				this.currentRequestError = 'error'
			}
			setTimeout(() => { // setTimeout required to prevent crashing by destroying stream before finish error handling
				this.continue()
			}, 100)
		}
		return err
	}
    absolutize(path, url){
        if(path.match(new RegExp('^[htps:]*?//'))){
            return path
        }
        let uri = new URL(path, url)
        return uri.href
    }
	getTimeoutOptions(){
		if(this.opts.timeout && typeof(this.opts.timeout) == 'object' && this.opts.timeout.connect && this.opts.timeout.response) {
			return this.opts.timeout
		} else {
			let ms
			if(typeof(this.opts.timeout) == 'number' && this.opts.timeout > 0){
				ms = this.opts.timeout * 1000
			} else {
				ms = (global.config.get('connect-timeout') || 5) * 1000
			}
			return {
				lookup: ms,
				connect: ms,
				response: ms * 2
			}
		}
	}
	removeHeaders(headers, keys){
		keys.forEach(key => {
			if(['accept-encoding', 'content-encoding'].includes(key)){
				headers[key] = 'identity'
			} else {
				delete headers[key]
			}
		})
		return headers
	}
	parseResponse(response){
		if(this.destroyed) return
		if(this.opts.debug){
			console.log('>> Download response', response.statusCode, JSON.stringify(response.headers), this.currentURL, this.retryCount)
		}
		this.currentResponse = response
		this.responseSource = response.headers['x-source']
		let validate = this.validateResponse(response)
		if(validate === true){
			if(!this.isResponseCompressed){
				if(response.headers['content-type'] && response.headers['content-type'] == 'application/x-gzip'){
					this.isResponseCompressed = 'gzip'
				} else if(this.ext(this.currentURL) == 'gz'){
					this.isResponseCompressed = 'gzip'
				} else if(response.headers['content-encoding'] && response.headers['content-encoding'] != 'identity'){
					this.isResponseCompressed = response.headers['content-encoding']
				} else if(response.headers['content-disposition'] && response.headers['content-disposition'].match(new RegExp('filename.?=[^;]+\\.gz($|;|")'))){
					this.isResponseCompressed = 'gzip'
				}
			}
			if(this.opts.acceptRanges){
				if(typeof(response.headers['accept-ranges']) == 'undefined' || response.headers['accept-ranges'] == 'none'){
					if(typeof(response.headers['content-range']) == 'undefined'){
						this.opts.acceptRanges = false
					}
				}
			} else {
				if(typeof(response.headers['accept-ranges']) != 'undefined' && response.headers['accept-ranges'] != 'none'){
					this.opts.acceptRanges = true
				}
			}
			if(this.contentLength == -1 && typeof(response.headers['content-length']) != 'undefined'){
				if(response.statusCode == 200 || (response.statusCode == 206 && this.requestingRange && this.requestingRange.start == 0 && !this.requestingRange.end)){
					this.contentLength = parseInt(response.headers['content-length'])
					if(this.totalContentLength < this.contentLength){
						this.totalContentLength = this.contentLength
					}
					if(this.requestingRange){
						this.contentLength -= this.requestingRange.start
						if(this.requestingRange.start >= this.contentLength){
							this.statusCode = 416
							return this.end()
						}
					}
				}
			}
			if (typeof(response.headers['content-range']) != 'undefined') { // server support ranges, so we received the right data
				if(!this.opts.acceptRanges){
					this.opts.acceptRanges = true
				}
				let fullLength = 0, range = response.headers['content-range'].replace('bytes ', 'bytes=')
				if(range.indexOf('/') != -1){
					fullLength = parseInt(range.split('/').pop())
					if(!isNaN(fullLength) && this.totalContentLength < fullLength){
						this.totalContentLength = fullLength
					}
				}
				const ranges = parseRange(this.totalContentLength, range)
				if(this.opts.debug){
					console.log('>> Download response range', this.totalContentLength, range, ranges)
				}
				if (Array.isArray(ranges)) { // TODO: enable multi-ranging support
					this.receivingRange = ranges[0]
					if(this.contentLength == -1 && this.receivingRange.end && this.receivingRange.end > 0){
						if(this.opts.debug){
							console.log('Download update content length', this.requestingRange ? this.requestingRange.start : -1, this.receivingRange, this.received, fullLength, response.headers['content-range'])
						}
						if(this.requestingRange){
							// if(this.requestingRange.end will be not available here, as contentLength == -1
							this.contentLength = this.totalContentLength - this.requestingRange.start
						} else {
							this.contentLength = this.received + (this.receivingRange.end - this.receivingRange.start) + 1
						}
					}
				}
			} else { // no range support, so skip received bytes + requestingRange.start
				this.ignoreBytes = this.received
				if(this.requestingRange){
					this.ignoreBytes += this.requestingRange.start
				}
			}
			if(this.opts.downloadLimit && this.contentLength > this.opts.downloadLimit){
				this.emit('error', 'Download limit exceeds ' + this.contentLength + ' > ' + this.opts.downloadLimit)
				if(!this.headersSent){
					this.statusCode = 500
					this.headersSent = true
					this.emit('response', this.statusCode, {})
				}
				this.end()
			} else {
				if(!this.headersSent){
					let headers = response.headers
					headers = this.removeHeaders(headers, ['content-range', 'content-length', 'content-encoding', 'transfer-encoding', 'cookie']) // cookies will be handled internally by DownloadStream
					if(!this.statusCode || this.isPreferredStatusCode(response.statusCode)){
						this.statusCode = response.statusCode
					}
					if(this.requestingRange){
						this.statusCode = 206
						headers['content-range'] = 'bytes ' + this.requestingRange.start + '-'
						if(this.contentLength != -1){
							headers['content-range'] += (this.requestingRange.start + this.contentLength - 1)
							if(this.totalContentLength != -1){
								headers['content-range'] += '/' + this.totalContentLength
							} else {
								headers['content-range'] += '/*'
							}
						}
					} else if(this.statusCode == 206) { // we are internally processing ranges, but the client requested the full content
						this.statusCode = 200
					}
					if(this.opts.debug){
						console.log('>> Download response emit', this, this.requestingRange, this.statusCode, headers, this.isResponseCompressed)
					}
					this.headersSent = true
					if(this.totalContentLength > 0 && !this.requestingRange){
						headers['content-length'] = this.totalContentLength
					}
					this.emit('response', this.statusCode, headers)
				}
				response.on('data', chunk => {
					if(this.ended || this.destroyed){
						return this.destroyStream()
					}
					if(!Buffer.isBuffer(chunk)){
						chunk = Buffer.from(chunk)
					}
					// console.log('received data')
					if(this.ignoreBytes){
						if(this.ignoreBytes >= chunk.length){
							this.ignoreBytes -= chunk.length
							return
						} else {
							chunk = chunk.slice(chunk.length - this.ignoreBytes)
							this.ignoreBytes = 0
						}
					}
					if(this.contentLength != -1 && (chunk.length + this.received) > this.contentLength){
						console.error('Received more data then expected', this.contentLength, this, this.opts.url, this.received + chunk.length, global.traceback(), global.Download.cache.index[this.opts.url])
					}
					this.received += chunk.length
					this.emitData(chunk)
					this.updateProgress()
					let receiveLimit = 0
					if(typeof(this.opts.receiveLimit) == 'number'){
						receiveLimit = this.opts.receiveLimit
					}
					if(typeof(this.opts.downloadLimit) == 'number'){
						if(receiveLimit <= 0 || receiveLimit > this.opts.downloadLimit){
							receiveLimit = this.opts.downloadLimit
						}
					}
					if(receiveLimit && this.received > receiveLimit){
						this.isResponseCompressed = false
						if(this.opts.debug){
							console.log('>> Download receiving exceeded', this.received + ' > ' + receiveLimit, this.requestingRange, this.received, this.contentLength, this.totalContentLength)
						}
						this.end()
					}
					if(this.contentLength != -1 && this.received >= this.contentLength){ // already received whole content requested
						if(this.opts.debug){
							console.log('>> Download content received', this.requestingRange, this.received, this.contentLength, this.totalContentLength)
						}
						this.end()
					}
				})
				response.on('error', this.errorCallback.bind(this))
				const onend = () => {
					if(!this.destroyed && !this.ended){
						if(this.isResponseComplete(response.statusCode, response.headers)){
							if(this.opts.debug){
								console.log('server aborted, ended '+ this.contentLength)
							}
							this.end()
						} else {
							if(this.opts.debug){
								console.warn('aborted', global.traceback())
							}
							this.currentRequestError = 'aborted'
							let err = 'request aborted '+ this.received +'<'+ this.contentLength
							this.errors.push(err)
							if(global.osd && global.debugConns){
								let txt = this.opts.url.split('?')[0].split('/').pop() +' ('+ this.statusCode +'): '
								if(this.contentLength){
									txt += err // 'aborted, missing '+ global.kbfmt(this.contentLength - this.received)
								} else {
									txt += 'aborted, no response'
								}
								global.osd.show(txt, 'fas fa-download', 'down-'+ this.opts.uid, 'persistent')
							}
							if(!this.received){
								this.abortErrors++
								if(this.abortErrors >= this.opts.maxAbortErrors){
									return this.end()
								}
							}
							this.continue()
						}
					}
				}
				if(response.ended){
					onend()
				} else {
					response.once('end', onend)
				}
				if(this.opts.debug && !this.destroyed){
					console.log('>> Download receiving response', this.opts.url)
				}
			}
		} else if(validate === false) {
			this.continue()
		}
	}
	_emitData(chunk){
		if(!this.responseSource.startsWith('cache')){
			if(Download.p2p){
				Download.p2p.addStats(this.responseSource, chunk.length)
			}		
			if(this.opts.cacheTTL){
				Download.cache.save(this, chunk, false) // before to be converted by StringDecoder
			}
		}
		if(this.opts.encoding && this.opts.encoding != 'binary'){
			if(!this.stringDecoder){
				this.stringDecoder = new StringDecoder(this.opts.encoding)
			}
			chunk = this.stringDecoder.write(chunk)
		}
		this.receivedUncompressed += chunk.length
		if(this.listenerCount('data')){
			this.emit('data', chunk)
		} else {
			this.buffer.push(chunk)
		}
	}
	emitData(chunk){
		if(this.isResponseCompressed){
			if(!this.decompressor){				
				if(this.opts.debug){
					console.warn('Compression detected', this.isResponseCompressed)
				}
				switch(this.isResponseCompressed){
					case 'gzip':
						this.decompressor = zlib.createGunzip()
						break
					case 'deflate':
						this.decompressor = zlib.createInflate()
						break
					default:
						this.decompressor = zlib.createUnzip()
						break
				}
				this.decompressor.on('data', this._emitData.bind(this))
				this.decompressor.on('error', err => {
					console.error('Zlib err', err, this.currentURL)
					this.decompressEnded = 'error'
					this.emit('decompressed')
					this.destroyStream()
					if(!this.ended){
						this.connect()
					}
				})
				//this.decompressor.once('end', chunk => console.log('ZLIB END'))
				this.decompressor.on('finish', chunk => {
					this.decompressEnded = 'finish'
					this.emit('decompressed')
				})
				//this.decompressor.once('close', chunk => console.log('ZLIB CLS'))
			}
			//console.log('decompressor.write', chunk)
			this.decompressor.write(chunk)
		} else {
			this._emitData(chunk)
		}
	}
	isResponseComplete(statusCode, headers){
		if(statusCode == 416) {
			this.opts.acceptRanges = false
			return false
		}
		const isValidStatusCode = statusCode == 416 || (statusCode >= 200 && statusCode < 300)
		const isComplete = (this.contentLength == -1 && !this.opts.acceptRanges) || (this.contentLength > -1 && this.received >= this.contentLength)
		if(isValidStatusCode && isComplete && this.contentLength == -1 && !this.currentRequestError){ // ended fine
			this.contentLength = this.received // avoid loop retrying
			if(this.opts.debug){
				console.log('>> Download content length adjusted to', this.contentLength)
			}
		}
		return isValidStatusCode && isComplete // already received whole content requested
	}
	validateResponse(response){
		if(response.statusCode < 200 || response.statusCode >= 400){ // bad response, not a redirect
			this.errors.push(response.statusCode)
			let finalize
			if(response.statusCode == 406){
				console.error('406 error', response.headers, this.stream, this.opts.url)
			}
			if(this.opts.authErrorCodes.includes(response.statusCode)){
				if(this.retryDelay < 1000){
					this.retryDelay = 1000
				}
				this.authErrors++
				if(this.authErrors >= this.opts.maxAuthErrors){
					finalize = true
				} else {
					this.pingAuthURL()
				}
			}
			if(this.opts.permanentErrorCodes.includes(response.statusCode)){
				finalize = true
			}
			if(this.opts.acceptRanges && response.statusCode == 416){
				if(this.received){
					finalize = true // reached end, abort it
				} else {
					this.opts.acceptRanges = false // url doesn't supports ranges
				}
			}
			if(finalize){
				this.statusCode = response.statusCode
				this.end()
				return undefined // accept bad response and finalize it
			}
			if(this.retryCount < this.opts.retries){
				return false // return false to skip parseResponse and keep trying
			}
		}
		return true
	}
	checkRedirect(response){
		if(typeof(response.headers['location']) != 'undefined'){
			if(this.opts.cacheTTL){
				Download.cache.save(this, null, true) // save redirect, before changing currentURL, end it always despite of responseSource
			}
			this.currentURL = this.absolutize(response.headers['location'], this.opts.url)			
			if(this.opts.debug){
				console.log('>> Download redirect', this.opts.followRedirect, response.headers['location'], this.currentURL)
			}	
			this.redirectLog.push(this.currentURL)
			process.nextTick(() => {
				if(this.opts.followRedirect){
					this.destroyStream()
					if(this.redirectCount < this.opts.redirectionLimit){
						this.redirectCount++
						this.connect()
					} else {
						this.statusCode = 500
						this.headers = {}
						this.endWithError('Redirection limit reached')
					}
				} else {
					if(!this.headersSent){
						this.headersSent = true
						this.statusCode = (response.statusCode >= 300 && response.statusCode < 400) ? response.statusCode : 307
						this.headers = response.headers
						this.emit('response', this.statusCode, this.headers)
					}
					this.end()
				}
			})
			return true // location handled, return true to skip parseResponse
		}
	}
	isPreferredStatusCode(statusCode){
		return statusCode >= 200 && statusCode < 400 && 
			![206, 301, 302].includes(statusCode) // softly ignore these temp ones
	}
	addDefaultRequestHeaders(headers){
		headers['connection'] = this.opts.keepalive ? 'keep-alive' : 'close'
		return headers
	}
  	next(){
		if(this.opts.debug){
			console.log('next', global.traceback())
		}
		this.destroyStream()
		if(this.continueTimer){
			clearTimeout(this.continueTimer)
		}
		let retry
		if(!Download.isNetworkConnected){
			retry = false
		} else if(this.destroyed || this.ended || (this.received && !this.opts.resume)){
			return this.destroy()
		} else if(this.opts.permanentErrorCodes.includes(this.statusCode) || this.retryCount >= this.opts.retries) { // no more retrying, permanent error
			retry = false
		} else if(
			(this.contentLength >= 0 && this.received >= this.contentLength) || // requested content already received
			((!this.opts.acceptRanges || this.statusCode == 416) && this.contentLength == -1 && (this.statusCode >= 200 && this.statusCode < 300)) // unknown content length + good response received = no more retrying
			){
			retry = false
    	} else { // keep trying
			retry = true
			if(this.received == this.lastReceived || !this.statusCode || (this.statusCode < 200 || this.statusCode >= 400)){
				this.retryCount++
			}
			this.lastReceived = this.received
     		this.connect()
		}
		if(retry){
			if(this.opts.debug){
				console.log('retrying', this.destroyed, this.statusCode, this.currentURL, 'content: ' + this.received + '/' + this.contentLength, 'retries: ' + this.retryCount + '/'+ this.opts.retries)
			}
		} else {
			if(this.opts.debug){
				console.log('no retry', this.destroyed, this.statusCode, this.currentURL, 'content: ' + this.received + '/' + this.contentLength, 'retries: ' + this.retryCount + '/'+ this.opts.retries)
			}
			this.end()
		}
	}
	continue(){
		if(this.opts.debug){
			console.log('continue', global.traceback(), this.lastStatusCodeReceived)
		}
		this.destroyStream()
		if(this.continueTimer){
			clearTimeout(this.continueTimer)
		}
		if(this.isResponseComplete(this.lastStatusCodeReceived, this.lastHeadersReceived)){
			this.end()
		} else {
			let delay, overloaded = [429, 503, 521, 522, 524].includes(this.lastStatusCodeReceived)
			if(overloaded){
				if(this.lastHeadersReceived && this.lastHeadersReceived['retry-after']){
					delay = parseInt(this.lastHeadersReceived['retry-after'])
					if(isNaN(delay)){
						delay = Date.parse(this.lastHeadersReceived['retry-after'])
						if(typeof(delay) == 'number'){
							delay /= 1000
							delay -= global.time()
						}						
					}
				}
			}
			if(typeof(delay) != 'number'){
				if(overloaded){
					delay = 3000
				} else {
					delay = this.retryDelay
				}
			} else {
				delay *= 1000
				if(delay < this.retryDelay){
					delay = this.retryDelay
				} else if(delay > 30000) {
					delay = 30000
				}
			}
			this.continueTimer = setTimeout(this.next.bind(this), delay)
		}
	}
	updateProgress(){
		let current = this.progress
		if(this.ended){
			this.progress = 100
		} else {
			if(this.contentLength != -1){
				this.progress = parseInt(this.received / (this.contentLength / 100))
				if(this.progress > 99){
					this.progress = 99
				}
			} else {
				this.progress = 99
			}
		}
		if(this.progress != current && this.progress < 100){			
			if(global.osd && global.debugConns){
				let txt = this.opts.url.split('?')[0].split('/').pop() +': '+ this.progress	+'%'			
				global.osd.show(txt, 'fas fa-download', 'down-'+ this.opts.uid, 'persistent')
			}
			if(this.listenerCount('progress')){
				this.emit('progress', this.progress)
			}
		}
	}
	destroyStream(){
		if(this.currentResponse){
			//this.currentResponse.removeAllListeners()
			this.currentResponse = null
		}
		if(this.stream){
			let timings = this.parsePhases(this.stream.timings || {})
			Object.keys(timings).forEach(k => {
				if(typeof(this.timings[k]) == 'undefined'){
					this.timings[k] = 0
				}
				this.timings[k] += timings[k]
			})
			this.ignoreBytes = 0 // reset it
			if(this.opts.debug){
				console.log('destroyStream', global.traceback())		
			}
			//this.stream.removeAllListeners('response')
			//this.stream.removeAllListeners('data')
			//this.stream.removeAllListeners('end')
			this.stream.destroy()
			///this.stream.removeAllListeners()
			this.stream = null
		}
	}
	prepareOutputData(data){
		if(Array.isArray(data)){
			if(data.length && typeof(data[0]) == 'string'){
				data = data.join('')
			} else {
				data = Buffer.concat(data)
			}
		}
		switch(this.opts.responseType){
			case 'text':
				data = String(data)
				break
			case 'json':
				try {
					data = global.parseJSON(String(data))
				} catch(e) {
					if(this.listenerCount('error')){
						this.emit('error', e)
					}
					data = undefined
				}
				break
		}
		return data
	}
	endWithError(err){
		this.statusCode = 500
		this.headers = {}
		console.warn('Download error: '+ err, this.redirectLog, this.opts.url, this.currentURL, this.redirectCount, this, global.traceback())
		this.errors.push(String(err) || 'unknown request error')
		if(!this.currentRequestError){
			this.currentRequestError = 'error'
		}
		if(this.listenerCount('error')){
			this.emit('error', err)
		}
		this.end()
	}
	end(){
		if(!this.ended){
			this.destroyStream()
			if(this.destroyed){
				return
			}
			if(!this.headersSent){
				this.headersSent = true
				this.checkStatusCode()
				if(this.statusCode){
					this.emit('response', this.statusCode, {})
				} else if(this.listenerCount('error')) {
					this.emit('error', 'unknown error')
				}
			}
			if(!this.isResponseCompressed || this.decompressEnded || !this.decompressor){
				this.ended = true
				this.emit('end', this.prepareOutputData(this.buffer))
				this.destroy()
			} else {
				this.on('decompressed', () => {
					// console.log('decompressor end', this.buffer)
					this.ended = true
					this.emit('end', this.prepareOutputData(this.buffer))
					this.destroy()
				})
				this.decompressor.flush()
				this.decompressor.end()
			}
		}
	}
	checkStatusCode(){
		if(this.statusCode == 0){
			const errs = this.errors.join(' ')
			if(errs.match(this.opts.permanentErrorRegex)){
				this.statusCode = -1
			} else {
				let codes = this.errors.filter(c => {
					c = Number(c)
					return c && !isNaN(c)
				})
				this.statusCode = codes.length ? codes[0] : -1
			}
			if(this.opts.debug){
				console.log('CANNOT RESOLVE?', errs, this.statusCode)
			}
		}
	}
	destroy(){
		if(!this.destroyed){
			if(this.opts.debug){
				console.log('destroy')
			}
			if(this.decompressor){
				this.decompressor.destroy()
			}
			if(!this.ended){
				this.ended = true
				this.emit('end')
			}
			if(this.opts.cacheTTL){
				Download.cache.save(this, null, true) // end it always despite of responseSource
			}
			this.destroyed = true
			this.destroyStream()
			this.emit('destroy')
			this.removeAllListeners()
			this.buffer = []
			process.nextTick(() => {
				if(global.osd && global.debugConns){
					let txt = this.opts.url.split('?')[0].split('/').pop() +' ('+ this.statusCode +') - '
					this.timings.delay = this.retryCount * this.retryDelay
					this.timings.ttotal = (global.time() - this.startTime) * 1000
					let ts = Object.keys(this.timings).filter(k => {
						return this.timings[k] >= 1000
					})
					let add = ts.map(k => {
						return (k == 'ttotal' ? 'total' : k) +': '+ parseInt(this.timings[k]/1000) +'s'
					}).join(', ')
					if(add){
						add += ', '
						txt += add
					}
					txt += global.kbfmt(this.received)
					global.osd.show(txt, 'fas fa-download', 'down-'+ this.opts.uid, 'long')
				}
			})
		}
	}
}

Download.stream = DownloadStreamHybrid
Download.cache = new DownloadCacheMap()
Download.keepAliveDomainBlacklist = []
Download.isNetworkConnected = true
Download.setNetworkConnectionState = state => {
	Download.isNetworkConnected = state
}
Download.head = (...args) => {
	let _reject, g, resolved, opts = args[0]
	let promise = new Promise((resolve, reject) => {
		_reject = reject
		g = new Download(opts)
		g.once('error', err => {
			if(resolved) return
			resolved = true
			reject(err)
		})
		g.once('response', (statusCode, headers) => {
			if(resolved) return
			resolved = true
			// console.log('Download', g, global.traceback(), buf)
			resolve({statusCode, headers})
			g.destroy()
		})
		g.once('end', buf => {
			if(resolved) return
			resolved = true
			// console.log('Download', g, global.traceback(), buf)
			reject('no response')
			g.destroy()
		})
		g.start()
	})
	promise.cancel = () => {
		if(!g.ended){
			_reject('Promise was cancelled')
			g.destroy()
		}
	}
	return promise
}
Download.get = opts => {
	let _reject, g, resolved
	const promise = new Promise((resolve, reject) => {
		_reject = reject
		g = new Download(opts)
		g.once('error', err => {
			if(resolved) return
			resolved = true
			reject(err)
		})
		g.once('end', buf => {
			if(resolved) return
			resolved = true
			// console.log('Download', g, global.traceback(), buf)
			if(g.statusCode >= 200 && g.statusCode < 400){
				resolve(buf)
			} else {
				reject('http error '+ g.statusCode)
			}
			g.destroy()
		})
		g.start()
	})
	promise.cancel = () => {
		if(g && !g.ended){
			_reject('Promise was cancelled')
			g.destroy()
		}
	}
	return promise
}
Download.file = (...args) => {
	let _reject, g, err, opts = args[0], file = opts && opts.file ? opts.file : global.paths.temp +'/dlf-'+ parseInt(Math.random() * 10000000000000)
	let promise = new Promise((resolve, reject) => {
		_reject = reject
		let writer
		g = new Download(opts)
		g.once('response', statusCode => {
			// console.log('Download', g, global.traceback(), buf)
			if(statusCode < 200 && statusCode >= 400){
				g.destroy()	
				reject('http error '+ statusCode)
			}
		})
		g.on('data', buf => {
			if(!writer){
				writer = new Writer(file)
				writer.autoclose = false
			}
			writer.write(buf)
		})
		g.on('error', e => {
			err = e
		})
		g.once('end', () => {
			g.destroy()
			if(writer){
				if(writer.hasErr){
					reject(writer.hasErr)
				} else {
					writer.ready(() => {
						writer.destroy()
						resolve(file)
					})
				}
			} else {
				reject(err || 'empty data '+ g.statusCode)
			}
		})
		if(typeof(opts.progress) == 'function'){
			g.on('progress', opts.progress)
		}
		g.start()
	})
	promise.cancel = () => {
		if(!g.ended){
			_reject && _reject('Promise was cancelled')
			g.destroy()
			const fs = require('fs')
			fs.stat(file, (err, stat) => {
				if(stat && stat.size){
					fs.unlink(file, () => {})
				}
			})
		}
	}
	return promise
}

module.exports = Download