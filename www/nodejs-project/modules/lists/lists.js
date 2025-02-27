
const fs = require('fs'), async = require('async'), pLimit = require('p-limit')
const Parser = require('./parser'), Manager = require('./manager')
const Index = require('./index'), List = require('./list'), EPG = require('../epg')

class ListsEPGTools extends Index {
    constructor(opts){
		super(opts)
		this._epg = false
        this.manager = new Manager(this)
	}
	loadEPG(url){
		return new Promise((resolve, reject) => {
			if(this._epg){
				if(this._epg.url != url){
					console.error('changed epg url', this._epg.url, url)
					this._epg.destroy()
					delete this._epg
				} else {
					console.error('same epg url', this._epg.url, !!this._epg.parser)
					if(this._epg.loaded){						
						resolve()
					} else if(this._epg.error) {
						reject(this._epg.error)
					} else {
						this._epg.once('load', () => {				
							console.log('loadEPG success') //, JSON.stringify(this._epg.data))
							resolve()
						})
						this._epg.once('error', reject)
					}
					return
				}
			}
			if(url){
				let resolved, retries = 2
				const load = () => {
					this._epg = new EPG(url)
					this._epg.once('load', () => {				
						console.log('loadEPG success') //, JSON.stringify(this._epg.data))
						if(!resolved){
							resolve()
							resolved = true
						}
					})
					this._epg.once('error', err => {
						if(!resolved){
							if(retries){
								this._epg && this._epg.destroy()
								retries--
								load()
							} else {
								reject(err)
								resolved = true
							}
						}
					})
					this._epg.on('error', console.error) // avoid ERR_UNHANDLED_ERROR
				}
				load()
			} else {
				resolve()
			}
		})
	}
	async epg(channelsList, limit){
		if(!this._epg){
			throw 'no epg 0'
		}
		let data
		if(this._epg.state == 'loaded' || Object.values(this._epg.data) >= 200){ // loaded enough
			if(Array.isArray(channelsList)){
				channelsList = channelsList.map(c => this.applySearchRedirectsOnObject(c))
				data = this._epg.getMulti(channelsList, limit)
			} else {
				channelsList = this.applySearchRedirectsOnObject(channelsList)
				data = this._epg.get(channelsList, limit)
			}
		} else {
			data = [this._epg.state]
			if(this._epg.state == 'error'){
				data.push(this._epg.error)
			} else if(this._epg.request){
				data.push(this._epg.request.progress)
			}
		}
		return data	
	}
	async epgExpandSuggestions(categories){
		if(!this._epg){
			throw 'no epg 1'
		}
		return this._epg.expandSuggestions(categories)
	}
	async epgSuggestions(categories, until, searchTitles){
		if(!this._epg){
			throw 'no epg 2'
		}
		return this._epg.getSuggestions(categories, until, searchTitles)
	}
	async epgSearch(terms, nowLive){
		if(!this._epg){
			throw 'no epg 3'
		}
		return await this._epg.search(this.applySearchRedirects(terms), nowLive)
	}
	async epgSearchChannel(terms){
		if(!this._epg){
			throw 'no epg 4'
		}
		return this._epg.searchChannel(this.applySearchRedirects(terms))
	}
	async epgSearchChannelIcon(terms){
		if(!this._epg){
			throw 'no epg 5'
		}
		return this._epg.searchChannelIcon(this.applySearchRedirects(terms))
	}
	async epgData(){
		if(!this._epg){
			throw 'no epg 6'
		}
		return this._epg.data
	}
	async foundEPGs(){
		return this.epgs
	}
	epgChannelsListSanityScore(data){
		let count = Object.keys(data).length, idealCatCount = 8
		if(count < 3){ // too few categories
			return 0
		}
		let c = Math.abs(count - idealCatCount)
		return 100 - c
	}
	async epgFindChannel(data){
		return this._epg.findChannel(data)
	}
	epgLiveNowChannelsList(){
		return new Promise((resolve, reject) => {
			if(!this._epg){
				return reject('no epg 8')
			}
			let data = this._epg.liveNowChannelsList()
			if(data && data['categories'] && Object.keys(data['categories']).length){
				let currentScore = this.epgChannelsListSanityScore(data['categories'])
				async.eachOfLimit(Object.keys(this.lists), 2, (url, i, done) => {
					if(this.lists[url].index.meta['epg'] == this._epg.url){
						let categories = {}
						this.lists[url].iterate(e => {
							if(e.groupName && this._epg.findChannel(this.terms(e.name))){
								if(typeof(categories[e.groupName]) == 'undefined'){
									categories[e.groupName] = []
								}
								if(!categories[e.groupName].includes(e.name)){
									categories[e.groupName].push(e.name)
								}
							}
						}, null, () => {
							let newScore = this.epgChannelsListSanityScore(categories)
							console.warn('epgChannelsList', categories, currentScore, newScore)
							if(newScore > currentScore){
								data.categories = categories
								data.updateAfter = 24 * 3600
								currentScore = newScore
							}
							done()
						})
					} else done()
				}, () => {
					resolve(data)
				})
			} else {
				console.error('epgLiveNowChannelsList FAILED', JSON.stringify(data), ' || ', JSON.stringify(this._epg.data))
				reject('failed')
			}
		})		
	}
	async epgChannelsTermsList(){
		if(!this._epg){
			throw 'no epg'
		}
		let data = this._epg.terms
		if(data && Object.keys(data).length){
			return data
		} else {
			throw 'failed'
		}
	}
}

class Lists extends ListsEPGTools {
    constructor(opts){
		super(opts)
        this.debug = false
        this.lists = {}
		this.activeLists = {
			my: [],
			community: [],
			length: 0
		}
		this.epgs = []
        this.myLists = []
        this.communityLists = []
		this.relevantKeywords = []
		this.requesting = {}
		this.loadTimes = {}
		this.satisfied = false
		this.syncListsQueue = {}
		this.syncListsConcurrencyLimit = 2
		this.isUpdaterFinished = true // true by default
		global.config.on('change', keys => {
			keys.includes('lists') && this.configChanged()
		})
		this.configChanged()
	}
	configChanged(){
		const myLists = global.config.get('lists').map(l => l[1])
		const newLists = myLists.filter(u => !this.myLists.includes(u))
		const rmLists = this.myLists.filter(u => !myLists.includes(u))
		this.myLists = myLists
		rmLists.forEach(u => this.remove(u))
		newLists.forEach(u => this.syncLoadList(u))
	}
	async isListCached(url){
		let err, file = global.storage.raw.resolve(LIST_DATA_KEY_MASK.format(url))
		const stat = await fs.promises.stat(file).catch(e => err = e)
		return (stat && stat.size >= 1024)
	}
	async filterCachedUrls(urls){
		if(this.debug) console.log('filterCachedUrls', urls.join("\r\n"))
		let loadedUrls = [], cachedUrls = []
		urls = urls.filter(u => {
			if(typeof(this.lists[u]) == 'undefined'){
				return true
			}
			loadedUrls.push(u)
		})
		if(urls.length){
			const limit = pLimit(8), tasks = urls.map(url => {
				return async () => {
					let err
					const has = await this.isListCached(url).catch(e => err = e)
					if(this.debug) console.log('filterCachedUrls', url, has)
					if(has === true){
						cachedUrls.push(url)
						if(!this.requesting[url]){
							this.requesting[url] = 'cached, not added'
						}
					} else {					
						if(!this.requesting[url]){
							this.requesting[url] = err || 'not cached'
						}
					}
				}
			}).map(limit)
			await Promise.allSettled(tasks).catch(console.error)
		}
		if(this.debug) console.log('filterCachedUrls', loadedUrls.join("\r\n"), cachedUrls.join("\r\n"))
		loadedUrls.push(...cachedUrls)
		return loadedUrls
	}
	async updaterFinished(isFinished){
		this.isUpdaterFinished = isFinished
		return this.isUpdaterFinished
	}
	async keywords(relevantKeywords){
		if(relevantKeywords && relevantKeywords.length){
            this.relevantKeywords = relevantKeywords
        }
		return this.relevantKeywords || []
	}
	setCommunityLists(communityLists){
		 // communityLists for reference (we'll use it to calc lists loading progress)
		communityLists.forEach(url => {
			if(!this.communityLists.includes(url)){
				this.communityLists.push(url)
			}
		})
		return true
	}
	async loadCachedLists(lists){
        let hits = 0
        if(this.debug){
            console.log('Checking for cached lists...', lists)
        }
		if(!lists.length) return hits
		lists.forEach(url => {
            if(!this.loadTimes[url]){
                this.loadTimes[url] = {}
            }
            this.loadTimes[url].sync = global.time()
        })
        lists = await this.filterCachedUrls(lists)
        lists.forEach(url => {
            if(!this.loadTimes[url]){
                this.loadTimes[url] = {}
            }
            this.loadTimes[url].filtered = global.time()
        })
        this.isFirstRun = !lists.length // is first load if has no cached lists
        this.delimitActiveLists() // helps to avoid too many lists in memory
        for(let url of lists) {
            if(typeof(this.lists[url]) == 'undefined') {
				hits++
                await this.syncList(url).catch(err => {
					console.error(err)
				})
            }
        }
        if(this.debug){
            console.log('sync ended')
        }
        return hits
    }
	status(url=''){
		let progress = 0, progresses = [], firstRun = true, satisfyAmount = this.myLists.length				
		let isUpdatingFinished = this.isUpdaterFinished && !this.syncingListsCount()
		if(isUpdatingFinished){
			progress = 100
		} else {
            const camount = global.config.get('communitary-mode-lists-amount')
			if(!camount && !this.myLists.length){
				progress = 100
			} else {
				if(this.myLists.length){
					progresses.push(...this.myLists.map(url => this.lists[url] ? this.lists[url].progress() : 0))
				}
				if(camount > satisfyAmount){
					// let satisfyAmount -1 below from communitary-mode-lists-amount
					// limit satisfyAmount to 8
					satisfyAmount += Math.max(1, Math.min(8, camount, this.communityLists.length) - 1)
					progresses.push(...Object.keys(this.lists).filter(url => !this.myLists.includes(url)).map(url => this.lists[url].progress()).sort((a, b) => b - a).slice(0, satisfyAmount))
				}
				if(this.debug){
					console.log('status() progresses', progresses)
				}
				progress = parseInt(progresses.length ? (progresses.reduce((a, b) => a + b, 0) / satisfyAmount) : 0)
				if(progress == 100){
					if(!isUpdatingFinished && Object.keys(this.lists).length < satisfyAmount){
						progress = 99
					}
				} else {
					if(isUpdatingFinished){
						progress = 100
					}
				}
			}
		}
		if(progress > 99) {
			if(!this.satisfied) {
				this.satisfied = true
				this.emit('satisfied')
			}
		} else {
			if(this.satisfied) {
				this.satisfied = false				
			}
		}
		if(this.debug){
			console.log('status() progresses', progress)
		}
		return {url, progress, firstRun, length: Object.values(this.lists).filter(l => l.isReady).length}
	}
	loaded(){
		return this.status().progress > 99
	}
	isSyncing(url){
		return Object.keys(this.syncListsQueue).some(u => {
			if(u == url){
				return true
			}
		})
	}
	syncingActiveListsCount(){
		let size = 0
		Object.keys(this.syncListsQueue).forEach(url => {
			if(this.syncListsQueue[url].active) size++
		})
		return size
	}
	syncingListsCount(){
		let size = 0
		Object.values(this.syncListsQueue).forEach(e => {
			size++
		})
		return size
	}
    syncEnqueue(url){
        return new Promise((resolve, reject) => {
            if(typeof(this.syncListsQueue[url]) == 'undefined'){
                this.syncListsQueue[url] = {active: false, resolves: [], rejects: []}
            }
            this.syncListsQueue[url].resolves.push(resolve)
            this.syncListsQueue[url].rejects.push(reject)
        })
	}
	syncPump(syncedUrl, err){
		if(syncedUrl && typeof(this.syncListsQueue[syncedUrl]) != 'undefined'){
			if(err){
				this.syncListsQueue[syncedUrl].rejects.forEach(r => r(err))
			} else {
				this.syncListsQueue[syncedUrl].resolves.forEach(r => r())
			}
			delete this.syncListsQueue[syncedUrl]
		}
		this.emit('sync-status', this.status(syncedUrl))
		if(this.syncingActiveListsCount() < this.syncListsConcurrencyLimit){
			return Object.keys(this.syncListsQueue).some(url => {
				if(!this.syncListsQueue[url].active){
					this.syncList(url, true).catch(() => {})
					return true
				}
			})
		}
	}
	async syncList(url, skipQueueing){
        if(skipQueueing !== true) {
            if(this.isSyncing(url) || this.syncingActiveListsCount() >= this.syncListsConcurrencyLimit){
                return await this.syncEnqueue(url)
            }
        }
        if(typeof(this.syncListsQueue[url]) == 'undefined'){
            this.syncListsQueue[url] = {
                active: true,
                resolves: [],
                rejects: []
            }
        } else {
            this.syncListsQueue[url].active = true
        }
        let err, contentLength
        this.syncListsQueue[url].object = [this.lists[url], 0]
        if(typeof(this.lists[url]) == 'undefined'){
            contentLength = await this.getListContentLength(url)
            this.syncListsQueue[url].object = [this.lists[url], 1]
            await this.syncLoadList(url, contentLength).catch(e => err = e)
        } else {
            let contentLength = await this.shouldReloadList(url)
            this.syncListsQueue[url].object = [this.lists[url], 2]
            if(typeof(contentLength) == 'number'){
				console.log('List got updated, reload it. '+ this.lists[url].contentLength +' => '+ contentLength)
                await this.syncLoadList(url, contentLength).catch(e => err = e)
            } else {
                err = 'no need to update'
            }
        }
        this.syncListsQueue[url].object = [this.lists[url], 3]
        this.syncPump(url, err)
	}
	async syncLoadList(url, contentLength){
		url = global.forwardSlashes(url)
		console.log('syncLoadList', url, contentLength)
		if(typeof(contentLength) != 'number'){ // contentLength controls when the list should refresh
			let err
			const meta = await this.getListMeta(url).catch(e => err = e)
			if(err){
				console.error(err)
				contentLength = 0 // ok, give up and load list anyway
			} else {
				contentLength = meta.contentLength
				if(typeof(contentLength) != 'number'){
					contentLength = 0 // ok, give up and load list anyway
				}
			}
		}
		let err, isMine = this.myLists.includes(url)
		if(this.debug){
			console.log('syncLoadList start', url)
		}
		if(!this.loadTimes[url]){
			this.loadTimes[url] = {}
		} else {
			this.remove(url)
		}
		this.loadTimes[url].syncing = global.time()
		this.requesting[url] = 'loading'		
		const list = new List(url, this, this.relevantKeywords)
		list.skipValidating = true // list is already validated at lists/driver, always
		list.contentLength = contentLength
		list.once('destroy', () => {
			if(!this.requesting[url] || (this.requesting[url] == 'loading')){
				this.requesting[url] = 'destroyed'
			}
			if(isMine && this.myLists.includes(url)){ // isMine yet?
				console.error('Damn! My list got destroyed!', url)
			}
			this.remove(url)
		})
		this.lists[url] = list
		await list.start().catch(e => err = e)
		if(err){ 
			//console.warn('LOAD LIST FAIL', url, list)
			this.loadTimes[url].synced = global.time()
			if(!this.requesting[url] || (this.requesting[url] == 'loading')){
				this.requesting[url] = String(err)
			}
			console.warn('syncLoadList error: ', err)
			if(this.lists[url] && !this.myLists.includes(url)){
				this.remove(url)												
			}
			throw err
		} else {
			this.loadTimes[url].synced = global.time()
			if(this.debug){
				console.log('syncLoadList started', url)
			}
			let repeated
			if(!this.lists[url] || (repeated=this.isRepeatedList(url))) {
				if(!this.requesting[url] || (this.requesting[url] == 'loading')){
					this.requesting[url] = repeated ? 'repeated at '+ repeated : 'loaded, but destroyed'
				}
				if(this.debug){
					if(repeated){
						console.log('List '+ url +' repeated, discarding.')
					} else {
						console.log('List '+ url +' already discarded.')
					}
				}
				throw 'list discarded'
			} else {	
				if(this.debug){
					console.log('syncLoadList else', url)
				}			
				this.setListMeta(url, list.index.meta).catch(console.error)
				if(list.index.meta['epg'] && !this.epgs.includes(list.index.meta['epg'])){
					this.epgs.push(list.index.meta['epg'])
				}
				if(this.debug){
					console.log('syncLoadList else', url)
				}			
				const contentAlreadyLoaded = await this.isSameContentLoaded(list)
				if(this.debug){
					console.log('syncLoadList contentAlreadyLoaded', contentAlreadyLoaded)
				}			
				if(contentAlreadyLoaded){
					this.requesting[url] = 'content already loaded'
					if(this.debug){
						console.log('Content already loaded', url)
					}
					if(this.debug){
						console.log('syncLoadList end: already loaded')
					}
					throw 'content already loaded'
				} else {
					let replace
					if(list){
						this.requesting[url] = 'added'
						if(!isMine && this.loadedListsCount() >= (this.myLists.length + global.config.get('communitary-mode-lists-amount'))){
							replace = this.shouldReplace(list)
							if(replace){
								const pr = this.lists[replace].relevance.total
								if(this.debug){
									console.log('List', url, list.relevance.total, 'will replace', replace, pr)
								}
								this.remove(replace)
								this.requesting[replace] = 'replaced by '+ url +', '+ pr +' < '+ list.relevance.total
								this.requesting[url] = 'added in place of '+ replace +', '+ pr +' < '+ list.relevance.total
							}
						}
						if(this.debug){
							console.log('Added community list...', url, list.index.length)
						}
					} else if(!this.requesting[url] || this.requesting[url] == 'loading') {
						this.requesting[url] = 'adding error, instance not found'
					}
					if(!replace){
						this.delimitActiveLists()
					}
					this.searchMapCacheInvalidate()
				}
			}
		}
		this.updateActiveLists()
		return true
	}
	async getListContentLength(url){
		const updateMeta = await this.getListMeta(url)
        return updateMeta.contentLength
	}
	async shouldReloadList(url){
		let loadedContentLength = this.lists[url].contentLength
		const updatedContentLength = await this.getListContentLength(url)
		if(updatedContentLength > 0 && updatedContentLength == loadedContentLength){
			return false
		} else {
			return updatedContentLength
		}
	}
	shouldReplace(list){
		if(!list){
			console.error('shouldReplace error: no list given', list)
			return
		}
		let weaker
		Object.keys(this.lists).forEach(k => {
			if(this.myLists.includes(k) || !this.lists[k].isReady){
				return
			}
			if(!weaker || (this.lists[k].relevance.total > -1 && this.lists[k].relevance.total < this.lists[weaker].relevance.total)){
				weaker = k
			}
		})
		if(weaker && this.lists[weaker] && this.lists[weaker].relevance.total < list.relevance.total){
			return weaker
		}
	}
	isRepeatedList(url){
		if(!url || !this.lists[url] || !this.lists[url].index || this.myLists.includes(url)){
			return
		}
		let dup
		Object.keys(this.lists).some(k => {
			if(k == url || !this.lists[k].index){
				return
			}
			if(this.lists[k].index.length == this.lists[url].index.length){
				if(JSON.stringify(this.lists[k].index.length) == JSON.stringify(this.lists[url].index.length)) {
					dup = k
					return true
				}
			}
		})
		return dup
	}
	async isSameContentLoaded(list){
		let err, alreadyLoaded, listDataFile = list.file, listIndexLength = list.index.length
		const stat = await fs.promises.stat(listDataFile).catch(e => err = e)
		if(err || stat.size == 0){
			return true // force this list discarding
		} else {
			const size = stat.size
			const limit = pLimit(3)
			const tasks = Object.keys(this.lists).map(url => {
				return async () => {
					if(!alreadyLoaded && url != list.url && this.lists[url] && this.lists[url].index.length == listIndexLength){
						let err
						const f = this.lists[url].file
						const a = await fs.promises.stat(f).catch(e => err = e)
						if(!err && !alreadyLoaded){
							if(this.debug){
								console.log('already loaded', list.url, url, f, listDataFile, size, s.size)
							}
							if(size == s.size){
								alreadyLoaded = true
							}
						}
					}
				}
			}).map(limit)
			await Promise.allSettled(tasks)
			return alreadyLoaded
		}
	}
	loadedListsCount(){
		return Object.values(this.lists).filter(l => l.isReady).length
	}
    updateActiveLists(){
		let communityUrls = Object.keys(this.lists).filter(u => !this.myLists.includes(u))
		this.activeLists = {
			my: this.myLists,
			community: communityUrls,
			length: this.myLists.length + communityUrls.length
		}
    }
    info(){
        const info = {}, current = global.config.get('lists')
		const hint = global.config.get('communitary-mode-lists-amount')
		Object.keys(this.lists).forEach(url => {
			info[url] = {url}
			info[url].owned = this.myLists.includes(url)
			info[url].score = this.lists[url].relevance.total
			if(this.lists[url].index.meta){
				info[url].name = this.lists[url].index.meta.name
				info[url].icon = this.lists[url].index.meta.icon
				info[url].epg = this.lists[url].index.meta.epg
			}
			info[url].length = this.lists[url].index.length
			current.forEach(c => {
				if(c[1] == url){
					info[url].name = c[0]
					if(c.length > 2) {
						Object.keys(c[2]).forEach(k => {
							info[url][k] = c[2][k]
						})
					}
				}
			})
			if(typeof(info[url]['private']) == 'undefined'){
				info[url]['private'] = !hint
			}
		})
		return info
    }
	isPrivateList(url){
		const ls = this.info()
		return ls[url] ? ls[url]['private'] : true
	}
	delimitActiveLists(){
        const camount = global.config.get('communitary-mode-lists-amount')
		if(this.loadedListsCount() > (this.myLists.length + camount)){
			let results = {}
			if(this.debug){
				console.log('delimitActiveLists', Object.keys(this.lists), camount)
			}
			Object.keys(this.lists).forEach(url => {
				if(!this.myLists.includes(url)){
					results[url] = this.lists[url].relevance.total
				}
			})
			let sorted = Object.keys(results).sort((a, b) => results[b] - results[a])
			sorted.slice(camount).forEach(u => {
				if(this.lists[u]){
					this.requesting[u] = 'destroyed on delimiting (relevance: '+ this.lists[u].relevance.total +'), '+ JSON.stringify(global.traceback()).replace(new RegExp('[^A-Za-z0-9 /:]+', 'g'), ' ')
					this.remove(u)
				}
			})
			if(this.debug){
				console.log('delimitActiveLists', Object.keys(this.lists), camount, results, sorted)
			}
		}
	}
	remove(u){
		if(typeof(this.lists[u]) != 'undefined'){
			this.searchMapCacheInvalidate(u)
			this.lists[u].destroy()
			delete this.lists[u]
			if(this.debug){
				console.log('Removed list', u)
			}
			this.updateActiveLists()
		}
	}
    async directListRenderer(v, opts){
        if(typeof(this.lists[v.url]) != 'undefined' && (!opts.fetch || (this.lists[v.url].isReady && !this.lists[v.url].indexer.hasFailed))){ // if not loaded yet, fetch directly
            let entries = await this.lists[v.url].getMap()
            return this.directListRendererPrepare(entries, v.url)
        } else if(opts.fetch) {
            let fetcher = new this.Fetcher(v.url, {
				progress: opts.progress
			}, this), entries = await fetcher.getMap()
            return await this.directListRendererPrepare(entries, v.url)
        } else {
			throw 'List not loaded'
		}
    }
    directListRendererParse(content){
        return new Promise((resolve, reject) => {
			let entries = [], parser = new Parser()
			parser.on('entry', e => entries.push(e))
			parser.once('end', () => {
				resolve(entries)
			})
			parser.write(content)
			parser.end()
        })
    }
    async directListRendererPrepare(list, url){
		if(typeof(this.directListRendererPrepareCache) == 'undefined'){
			this.directListRendererPrepareCache = {}
		}
		const cachettl = 3600, now = global.time(), olen = list.length
		if(typeof(this.directListRendererPrepareCache[url]) != 'undefined' && this.directListRendererPrepareCache[url].size == olen && this.directListRendererPrepareCache[url].time > (now - cachettl)){
			return this.directListRendererPrepareCache[url].list
		}
		if(list.length){
			list = this.tools.dedup(list) // dedup before parentalControl to improve blocking
			list = this.parentalControl.filter(list, true)
			list = this.prepareEntries(list)
			list = await this.tools.deepify(list, url)
		}
		if(olen >= this.opts.offloadThreshold){
			this.directListRendererPrepareCache[url] = {list, time: now, size: olen}
		}
		return list
    }
	isLocal(file){
		if(typeof(file) != 'string'){
			return
		}
		let m = file.match(new RegExp('^([a-z]{1,6}):', 'i'))
		if(m && m.length && (m[1].length == 1 || m[1].toLowerCase() == 'file')){ // drive letter or file protocol
			return true
		} else {
			if(file.length >= 2 && file.charAt(0) == '/' && file.charAt(1) != '/'){ // unix path
				return true
			}
		}
	}
	async setNetworkConnectionState(state){
        global.Download.setNetworkConnectionState(state)
		return true
	}
}

module.exports = Lists
