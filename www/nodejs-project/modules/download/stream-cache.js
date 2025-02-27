const fs = require('fs'), Events = require('events'), DownloadStreamBase = require('./stream-base')

class DownloadStreamCache extends DownloadStreamBase {
	constructor(opts){
		super(opts)
        this.type = 'cache'
	}
    async start(){
        if(this.started){
            throw 'Already started'
        }
        if(this.ended){
            throw 'Already ended'
        }
        if(this.destroyed){
            throw 'Already destroyed'
        }
        const url = this.opts.url
        const row = Download.cache.index[url]
        if(row && row.status && row.uid != this.opts.uid){
            let stream, range
            const headers = Object.assign({}, Download.cache.index[url].headers) || {}
            headers['x-source'] = headers['x-source'] ? 'cache-'+ headers['x-source'] : 'cache'
            if(this.opts.headers.range){
                range = this.parseRange(this.opts.headers.range)
                if(!range.end && row.size){
                    range.end = row.size
                }
                const total = row.type == 'saving' ? '*' : row.size
                const end = range.end || (total == '*' ? '*' : row.size - 1)
                headers['content-range'] = 'bytes='+ range.start +'-'+ end +'/'+ total
            }
            this.response = new DownloadStreamBase.Response(range ? 206 : 200, headers)
            this.emit('response', this.response)
            if(row.type == 'file' && row.size === 0){
                return this.end()
            }
            switch(row.type){
                case 'saving':
                    stream = Download.cache.index[url].chunks.createReadStream(range)
                    break
                case 'file':
                    stream = fs.createReadStream(String(row.data), range)
                    break
            }
            stream.on('error', err => {
                this.response.emit('error', err)
                this.end()
            })
            stream.on('data', chunk => {
                this.response.write(chunk)
            })
            if(stream.readableEnded || stream.closed){
                this.end()
            } else {
                stream.once('end', () => this.end())
            }
            return true
        } else {
            this.emitError('Cache download failed')
        }
    }
}

module.exports = DownloadStreamCache
