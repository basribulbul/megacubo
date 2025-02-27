const Events = require('events')

const DownloadStreamHttp = require('./stream-http')
const DownloadStreamCache = require('./stream-cache')
const DownloadStreamP2P = require('./stream-p2p')
const DownloadStreamBase = require('./stream-base')

class DownloadStream extends DownloadStreamBase {
	constructor(ropts, opts){
		super(ropts)
		this.ropts = ropts
		this.opts = opts
        this.timeout = opts.timeout
	}
	validate(response){
		return response.statusCode >= 200 && response.statusCode < 400 && 
			![204].includes(response.statusCode) // softly ignore these ones
	}
    async start(){
        const start = global.time()
        const types = [DownloadStreamHttp]
        let usecache, usep2p
        if(this.opts.cacheTTL) {
            usecache = true
            types.push(DownloadStreamCache)
        }
        if(this.opts.p2p === true && global.ui && global.Download.p2p){
            const peersCount = Object.keys(global.Download.p2p.peers).length
            if(peersCount >= 2){
                usep2p = true
                types.push(DownloadStreamP2P)
            } else {
                usep2p = false
            }
        }
        let chosen, responseData
        const vias = types.map((t, i) => {
            const opts = Object.assign({}, this.ropts)
            if(t == DownloadStreamHttp && (usep2p || usecache)) { // put a delay on http to give chance for p2p/cache
                opts.connectDelay = this.opts.p2pWaitMs
            }
            const via = new t(opts)
            via.once('response', response => {
                if(chosen){
                    return via.destroy()
                }
                via.validation = [response, this.validate(response)]
                if(this.validate(response)){
                    chosen = true
                    vias.filter(v => v != via).forEach(v => v.destroy())
                    response.headers['x-source'] = via.type
                    this.emit('response', response)
                    if(response.ended){
                        this.end()
                    } else {
                        response.once('end', () => this.end())
                    }
                } else {
                    if(response.statusCode && (!responseData || via.type == 'http')) {
                        responseData = {
                            statusCode: response.statusCode,
                            headers: response.headers
                        }
                    }
                    if(via.type == 'p2p' || (!usep2p && via.type == 'cache')) {
                        vias.filter(v => v.type == 'http').shift().skipWait()
                    }
                }
            })
            via.once('destroy', () => {
                if(chosen) {
                    return
                }
                process.nextTick(() => {
                    if(vias.every(v => v.destroyed)){
                        if(responseData){
                            responseData.headers['x-source'] = '' //vias
                            const response = new DownloadStreamBase.Response(responseData.statusCode, responseData.headers)
                            this.emit('response', response)
                            response.end()
                            this.end()
                        } else {
                            const err = vias.filter(v => v.type == 'http').map(v => v.errors.length ? v.errors[0] : null).pop() || 'Failed to fetch.'
                            this.emitError(err)
                        }
                    } else if(via.type == 'p2p' || (!usep2p && via.type == 'cache')) {
                        vias.filter(v => v.type == 'http').shift().skipWait()
                    }
                })
            })
            return via
        })
    }
}

DownloadStream.engines = {}

DownloadStream.engines.http = require('./stream-http')
DownloadStream.engines.cache = require('./stream-cache')
DownloadStream.engines.p2p = require('./stream-p2p')

module.exports = DownloadStream
