const fs = require('fs'), path = require('path'), Events = require('events')

class Writer extends Events {
	constructor(file){
		super()
		this.setMaxListeners(20)
		this.autoclose = true
		this.debug = false
		this.file = file
		this.written = 0
		this.writing = false
		this.writeQueue = []
		this.position = 0
	}
	write(data, position){
		if(typeof(position) == 'undefined'){
			position = this.position
			this.position += data.length
		}
		this.writeQueue.push({data, position})
		this.pump()
	}
	ready(cb){
		let finish = () => {
			if(this.fd){
				fs.close(this.fd, () => {})
				this.fd = null
			}
			cb()
		}
		if(this.writing || this.writeQueue.length){
			this.once('end', finish)
		} else {
			finish()
		}
	}
	prepare(cb){
		fs.access(this.file, err => {
			if(err){
				if(this.debug){
					console.log('writeat creating', this.file)
				}
				fs.mkdir(path.dirname(this.file), {recursive: true}, () => {
					fs.writeFile(this.file, '', cb)
				})
			} else {
				cb()
			}
		})
	}
	check(cb){
		fs.stat(this.file, (err) => cb(!err))
	}
	pump(){
		if(this.writing) {
			return
		}
		if(!this.writeQueue.length){
			return this.emit('end')
		}
		this.writing = true
		this.prepare(() => {
			this.open(this.file, 'r+', err => {
				if(err){
					console.error(err)
					this.writing = false
					this.writeQueue = []
					this.hasErr = err
					this.emit('end')
				} else {
					this._write(this.fd, () => {
						if(this.autoclose && this.fd){
							fs.close(this.fd, () => {})
							this.fd = null
						}
						this.writing = false
						this.emit('end')
					})
				}
			})
		})
	}
	open(file, flags, cb){
		if(this.fd){
			cb(null)
		} else {
			fs.open(this.file, 'r+', (err, fd) => {
				this.fd = fd
				cb(err)
			})
		}
	}
	_write(fd, cb){
		if(this.writeQueue.length){
			let {data, position} = this.writeQueue.shift(), len = data.length
			if(this.debug){
				console.log('writeat writing', this.file, fs.statSync(this.file).size, len, fs.statSync(this.file).size + len, position)
			}
			fs.write(fd, data, 0, data.length, position, (err, writtenBytes) => {
				if(err){
					if(this.debug){
						console.error('writeat error: '+ String(err), err)
					}
					if(this.destroyed){
						cb()
					} else {
						this.check(fine => {
							if(fine){
								this.writeQueue.unshift({data, position})
							}
							cb()
						})
					}
					return
				} else {
					this.written += writtenBytes
					if(writtenBytes < len){
						if(this.debug){
							console.warn('writeat written PARTIALLY', this.file, fs.statSync(this.file).size)
						}
						this.writeQueue.push({data: data.slice(writtenBytes), position: position + writtenBytes})
					} else {
						if(this.debug){
							console.log('writeat written', this.file, fs.statSync(this.file).size)
						}
					}
				}
				this._write(fd, cb)
			})
		} else {
			cb()
		}
	}
	destroy(){
		this.destroyed = parseInt(((new Date()).getTime() - this.uid) / 1000)
		this.writeQueue = []
		this.emit('destroy')
		this.removeAllListeners()
	}
}

module.exports = Writer
