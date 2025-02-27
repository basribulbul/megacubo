
const pLimit = require('p-limit'), List = require('./list')
const UpdateListIndex = require('./update-list-index'), ConnRacing = require('../conn-racing')
const Common = require('./common'), Cloud = require(global.APPDIR + '/modules/cloud')

require(global.APPDIR + '/modules/supercharge')(global)

storage = require(global.APPDIR + '/modules/storage')({})

Download = require(global.APPDIR + '/modules/download')
cloud = new Cloud()

const emit = (type, content) => {
	postMessage({id: 0, type: 'event', data: type +':'+ JSON.stringify(content)})
}

class ListsUpdater extends Common {
	constructor(){
		super()
		this.debug = false
		this.isUpdating = false
		this.relevantKeywords = []
		this.info = {}
	}
	async setRelevantKeywords(relevantKeywords){
		this.relevantKeywords = relevantKeywords
		return true
	}
	async getInfo(){
		return this.info
	}
    update(urls, concurrency){
		return new Promise((resolve, reject) => {
			if(!urls.length){
				return resolve(this.info)
			}
			if(this.isUpdating){
				return this.once('finish', () => {
					this.update(urls, concurrency).then(resolve).catch(reject)
				})
			}
			this.doUpdate(urls, concurrency).then(resolve).catch(reject)
		})
	}
	async doUpdate(urls, concurrency){
		if(this.debug){
			console.log('updater - start', urls)
		}
		this.info = {}
		this.isUpdating = true		
		this.racing = new ConnRacing(urls, {retries: 1, timeout: 5})
		const retries = []
		urls.forEach(url => this.info[url] = 'started')
		const limit = pLimit(concurrency)
		const tasks = new Array(urls.length).fill(async () => {
			if(this.debug){
				console.log('updater - nxt')
			}
			const res = await this.racing.next().catch(err => {
				console.error('updater - err', err)
			})
			if(this.debug){
				console.log('updater - nxct', res)
			}
			if(res && res.valid){
				this.info[res.url] = 'updating'
				if(this.debug){
					console.log('updater - updating', res.url)
				}
				let err
				const updated = await this.updateList(res.url).catch(e => err = e)
				if(typeof(err) != 'undefined'){
					this.info[res.url] = 'update failed, '+ String(err)
					console.error('updater - err: '+ err, global.traceback())
				} else {
					if(this.debug){
						console.log('updater - updated', res.url, updated)
					}
					if(updated){
						this.info[res.url] = 'updated'
						emit('list-updated', res.url)
					} else {
						this.info[res.url] = 'already updated'
					}
				}
			} else {
				if(res){
					this.info[res.url] = 'failed, '+ (res.status || 'timeout')
					if(this.debug){
						console.log('updater - failed', res.url, res)
					}
					retries.push(res.url)
				}
			}
		}, 0, urls.length).map(limit)
		if(this.debug){
			console.log('updater - z')
		}
		const ret = await Promise.allSettled(tasks)
		if(this.debug){
			console.log('updater - zz', JSON.stringify(ret))
		}
		this.isUpdating = false
		this.emit('finish')
		return this.info
    }
	async updateList(url, force){
		if(this.debug){
			console.log('updater updateList', url)
		}
		const should = force || (await this.updaterShouldUpdate(url))
		const now = global.time()
		if(this.debug){
			console.log('updater - should', url, should, force)
		}
		if(should){
			if(this.debug){
				console.log('updater - should', url, should)
			}
			const updateMeta = {}
			const file = global.storage.raw.resolve(global.LIST_DATA_KEY_MASK.format(url))
			const updater = new UpdateListIndex(url, url, file, this, Object.assign({}, updateMeta))
			updateMeta.updateAfter = now + 180
			if(this.debug){
				console.log('updater - should', url, should)
			}
			await this.setListMeta(url, updateMeta).catch(console.error)
			let ret
			if(this.debug){
				console.log('updater - should', url, should)
			}
			await updater.start()
			if(this.debug){
				console.log('updater - should', url, should)
			}
			if(updater.index){
				updateMeta.contentLength = updater.contentLength
				updateMeta.updateAfter = now + (24 * 3600)
				await this.setListMeta(url, updater.index.meta).catch(console.error)
				await this.setListMeta(url, updateMeta).catch(console.error)
				ret = true
			} 
			if(this.debug){
				console.log('updater - should', url, should)
			}
			updater.destroy()
			if(this.debug){
				console.log('updater - should', url, should)
			}
			return ret || false
		} else {
			return false // no need to update, by updateAfter
		}
	}
	async validateIndex(url){
		const list = new List(url, null, this.relevantKeywords)
		await list.start()
		const validated = list.index.length > 0
		list.destroy()
		return validated
	}
	async updaterShouldUpdate(url){
		const updateMeta = await this.getListMeta(url)
		if(this.debug){
			console.log('updater shouldUpdate', JSON.stringify(updateMeta, null, 3), url)
		}
		let now = global.time()
		let should = !updateMeta || now >= updateMeta.updateAfter
		if(!should){
			const valid = await this.validateIndex(url).catch(console.error)
			if(valid === true) {
				return false
			}
		}
		return true
	}
}


module.exports = ListsUpdater
