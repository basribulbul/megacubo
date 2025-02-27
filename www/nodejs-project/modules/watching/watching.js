const path = require('path'), async = require('async'), EntriesGroup = require('../entries-group')

class Watching extends EntriesGroup {
    constructor(){
        super('watching')
        this.timer = 0
        this.currentEntries = null
        this.currentRawEntries = null
        this.updateIntervalSecs = global.cloud.expires.watching
        global.config.on('change', (keys, data) => {
            if(keys.includes('only-known-channels-in-been-watched') || keys.includes('parental-control') || keys.includes('parental-control-terms')){
                this.update().catch(console.error)
            }
        })     
        global.storage.promises.get('watching-current').then(data => {
            global.channels.ready(() => {
                if(!this.currentRawEntries || !this.currentRawEntries.length){
                    this.currentRawEntries = data
                    this.update(data).catch(console.error)
                } else if(Array.isArray(data)) {                  
                    this.currentEntries.forEach((c, i) => {  
                        data.forEach(e => {
                            if(typeof(c.trend) == 'undefined' && typeof(e.trend) != 'undefined'){
                                this.currentEntries[i].trend = e.trend
                                return true
                            }
                        })
                        return e
                    })
                }
                global.channels.on('loaded', () => this.update().catch(console.error)) // on each "loaded"
            })
        }).catch(err => {
            console.error(err)
        })
    }
    title(){
        return global.lang.TRENDING
    }
    ready(cb){
        if(this.currentRawEntries){
            cb()
        } else {
            this.once('update', cb)
        }
    }
    showChannelOnHome(){
        return global.lists.manager.get().length || global.config.get('communitary-mode-lists-amount')
    }
    async update(rawEntries){
        clearTimeout(this.timer)
        let prv = this.entry()
        await this.process(rawEntries).catch(err => {
            console.error('watching '+ err)
            if(!this.currentRawEntries){
                this.currentEntries = []
                this.currentRawEntries = []
            }
        })
        clearTimeout(this.timer) // clear again to be sure
        this.timer = setTimeout(() => this.update().catch(console.error), this.updateIntervalSecs * 1000)
        this.emit('update')
        let nxt = this.entry()
        if(this.showChannelOnHome() && global.explorer.path == '' && (prv.details != nxt.details || prv.name != nxt.name)){
            global.explorer.updateHomeFilters()
        } else {
            this.updateView()
        }
    }
    updateView(){
        if(global.explorer.path == this.title()){
            global.explorer.refresh()
        }
    }
    hook(entries, path){
        return new Promise((resolve, reject) => {
            if(path == ''){
                let pos = 0, entry = this.entry()
                if(!entry.originalName){
                    entries.some((e, i) => {
                        if(e.name == global.lang.TOOLS){
                            pos = i + 1
                            return true
                        }
                    })
                }
                entries = entries.filter(e => e.hookId != this.key)
                entries.splice(pos, 0, entry)
            }
            resolve(entries)
        })
    }
    extractUsersCount(e){
        if(e.users){
            return e.users
        }
        let n = String(e.label || e.details).match(new RegExp('([0-9]+)($|[^&])'))
        return n && n.length ? parseInt(n[1]) : 0 
    }
    entries(){
        return new Promise((resolve, reject) => {
            if(!global.lists.loaded()){
                return resolve([global.lists.manager.updatingListsEntry()])
            }
            if(!global.lists.activeLists.length){
                return resolve([global.lists.manager.noListsEntry()])
            }
            this.ready(() => {
                let list = this.currentEntries ? global.deepClone(this.currentEntries, true) : []
                list = list.map((e, i) => {
                    e.position = (i + 1)
                    return e
                })
                if(!list.length){
                    list = [{name: global.lang.EMPTY, fa: 'fas fa-info-circle', type: 'action', class: 'entry-empty'}]
                } else {
                    const acpolicy = global.config.get('parental-control')
                    if(['remove', 'block'].includes(acpolicy)){
                        list = global.lists.parentalControl.filter(list)		
                    } else if(acpolicy == 'only') {
                        list = global.lists.parentalControl.only(list)
                    }     
                }
                list = this.prepare(list) 
                global.channels.epgChannelsAddLiveNow(list, false).then(resolve).catch(reject)
            })       
        })
    }
    applyUsersPercentages(entries){
        let totalUsersCount = 0
        entries.forEach(e => totalUsersCount += e.users)
        let pp = totalUsersCount / 100
        entries.forEach((e, i) => {
            entries[i].usersPercentage = e.users / pp
        })
        return entries
    }
    async getRawEntries(){
        let data = []
        const locales = await global.lang.getActiveLanguages()
        await Promise.allSettled(locales.map(async locale => {
            let es = await global.cloud.get('watching.'+ locale, false).catch(console.error)
            if(Array.isArray(es)) {
                data.push(...es)
            }
        }))
        data.forEach((e, i) => {
            if(e.logo && !e.icon){
                data[i].icon = e.logo
                delete data[i].logo
            }
        })
        return data
    }
    async process(rawEntries){
        let data = Array.isArray(rawEntries) ? rawEntries : (await this.getRawEntries())
        let recoverNameFromMegaURL = true, ex = !global.config.get('communitary-mode-lists-amount') // we'll make entries URLless for exclusive mode, to use the provided lists only
        data = global.lists.prepareEntries(data)
        data = data.filter(e => (e && typeof(e) == 'object' && typeof(e.name) == 'string')).map(e => {
            let isMega = global.mega.isMega(e.url)
            if(isMega && recoverNameFromMegaURL){
                let n = global.mega.parse(e.url)
                if(n && n.name){
                    e.name = global.ucWords(n.name)
                }
            }
            e.name = global.lists.parser.sanitizeName(e.name)
            e.users = this.extractUsersCount(e)
            e.details = ''
            if(ex && !isMega){
                e.url = global.mega.build(e.name)
            }
            return e
        })
        data = global.lists.parentalControl.filter(data)
        this.currentRawEntries = data.slice(0)
        const adultContentOnly = global.config.get('parental-control') == 'only', onlyKnownChannels = !adultContentOnly && global.config.get('only-known-channels-in-been-watched')
        let groups = {}, gcount = {}, gentries = []
        let sentries = await global.search.searchSuggestionEntries()
        let gsearches = [], searchTerms = sentries.map(s => s.search_term).filter(s => s.length >= 3).filter(s => !global.channels.isChannel(s)).filter(s => global.lists.parentalControl.allow(s)).map(s => global.lists.terms(s))
        data.forEach((entry, i) => {
            let ch = global.channels.isChannel(entry.terms.name)
            if(!ch){
                searchTerms.some(terms => {
                    if(global.lists.match(terms, entry.terms.name)){
                        const name = terms.join(' ')
                        if(!gsearches.includes(name)){
                            gsearches.push(name)
                        }
                        ch = {name}
                        return true
                    }
                })
            }
            if(ch){ 
                let term = ch.name
                if(typeof(groups[term]) == 'undefined'){
                    groups[term] = []
                    gcount[term] = 0
                }
                if(typeof(entry.users) != 'undefined'){
                    entry.users = this.extractUsersCount(entry)
                }
                gcount[term] += entry.users
                delete data[i]
            } else {
                if(onlyKnownChannels){
                    delete data[i]
                } else if(global.mega.isMega(entry.url)) {
                    data[i] = global.channels.toMetaEntry(entry)
                }
            }
        })
        Object.keys(groups).forEach(n => {
            const name = global.ucWords(n)
            gentries.push(global.channels.toMetaEntry({
                name, 
                type: 'group',
                fa: 'fas fa-play-circle',
                users: gcount[n],
                url: gsearches.includes(n) ? global.mega.build(name, {terms: n.split(' '), mediaType: 'all'}) : undefined
            }))
        })
        data = data.filter(e => {
            return !!e
        })
        data.push(...gentries)
        data = data.sortByProp('users', true)
        data = this.addTrendAttr(data)
        data = this.applyUsersPercentages(data)
        this.currentEntries = data
        global.storage.promises.set('watching-current', this.currentRawEntries, true).catch(console.error)
        return data
    }
    addTrendAttr(entries){
        if(this.currentEntries){
            const k = entries.some(e => e.usersPercentage) ? 'usersPercentage' : 'users'
            entries.map(e => {
                this.currentEntries.some(c => {
                    if(c.url == e.url){
                        if(e[k] > c[k]) {
                            e.trend = 1
                        } else if(e[k] < c[k]) {
                            e.trend = -1
                        } else if(typeof(c.trend) == 'number') {
                            e.trend = c.trend
                        }
                        return true
                    }
                })
                return e
            })
        }
        return entries
    }
    order(entries){
        return new Promise((resolve, reject) => {
            if(this.currentRawEntries){
                let up = [], es = entries.slice(0)
                this.currentRawEntries.forEach(r => {
                    es.some((e, i) => {
                        if(r.url == e.url){
                            e.users = r.users
                            up.push(e)
                            delete es[i]
                            return true
                        }
                    })
                })
                up.push(...es.filter(e => { return !!e }))
                resolve(up)
            } else {
                resolve(entries)
            }     
        })
    }
    entry(){
        const entry = {name: this.title(), details: global.lang.BEEN_WATCHED, fa: 'fas fa-chart-bar', hookId: this.key, type: 'group', renderer: this.entries.bind(this)}
        if(this.currentEntries && this.showChannelOnHome()){
            let top, rootPage = global.explorer.pages['']
            this.currentEntries.some(e => {
                if(!rootPage.some(r => (r.name == e.name && r.hookId != this.key)) && global.channels.isChannel(e.name)){
                    top = e
                    return true
                }
            })
            if(top){
                let s = top.users == 1 ? 'user' : 'users'
                entry.name = this.title()
                entry.class = 'entry-icon' 
                entry.originalName = top.name
                entry.prepend = '<i class="fas fa-chart-bar"></i> '
                entry.details = top.name + ' &middot; <i class="fas fa-'+ s +'"></i> '+ global.lang.X_WATCHING.format(top.users)
            }
        }
        return entry
    }
}

module.exports = Watching
