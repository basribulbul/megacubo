
const Events = require('events'), fs = require('fs'), ParentalControl = require(global.APPDIR + '/modules/lists/parental-control')
const M3UParser = require(global.APPDIR + '/modules/lists/parser'), M3UTools = require(global.APPDIR + '/modules/lists/tools'), MediaStreamInfo = require(global.APPDIR + '/modules/lists/media-info')

class Common extends Events {
	constructor(opts){
		super()
		this.searchRedirects = []
		this.stopWords = ['sd', 'hd', 'tv', 'h264', 'h.264', 'fhd'] // common words to ignore on searching
		this.watchingListId = 'watching.list'
		this.opts = {
			folderSizeLimit: 96,
			folderSizeLimitTolerance: 12,
			paginateThreshold: 128,
			offloadThreshold: 512
		}
        if(opts){
            Object.keys(opts).forEach(k => {
                this[k] = opts[k]
            })
        }
        this.parser = new M3UParser()
        this.tools = new M3UTools(opts)
        this.msi = new MediaStreamInfo()
		this.parentalControl = new ParentalControl()
		this.loadSearchRedirects()
	}
    joinPath(folder, file){
        let ret = folder
        if(ret.charAt(ret.length - 1) != '/'){
            ret += '/'
        }
        ret += file
        return ret
    }
	loadSearchRedirects(){
		if(!this.searchRedirects.length){
			fs.readFile(this.joinPath(__dirname, 'search-redirects.json'), (err, content) => { // redirects to find right channel names, as sometimes they're commonly refered by shorter names on IPTV lists
				console.warn('loadSearchRedirects', err, content)
				if(err){
					console.error(err)
				} else {
					let data = JSON.parse(String(content))
					if(data && typeof(data) == 'object'){
						let results = []
						Object.keys(data).forEach(k => {
							results.push({from: lists.terms(k), to: lists.terms(data[k])})
						})
						this.searchRedirects = results
					}
				}
			})
		}
	}
	applySearchRedirects(terms){
		this.searchRedirects.forEach(redirect => {
			if(redirect.from && redirect.from.length && redirect.from.every(t => terms.includes(t))){
				terms = terms.filter(t => !redirect.from.includes(t)).concat(redirect.to)
			}
		})
		return terms
	}
	applySearchRedirectsOnObject(e){
		if(Array.isArray(e)){
			e = this.applySearchRedirects(e)
		} else if(e.terms) {
			if(typeof(e.terms.name) != 'undefined' && Array.isArray(e.terms.name)){
				e.terms.name = this.applySearchRedirects(e.terms.name)
			} else if(Array.isArray(e.terms)) {
				e.terms = this.applySearchRedirects(e.terms)
			}
		}
		return e
	}
	terms(txt, allowModifier){
		if(!txt){
			return []
		}
		if(txt.indexOf('/') != -1){
			txt = txt.split('/').join(' ')
		}
		txt = txt.toLowerCase()
		return this.applySearchRedirects(txt.replace(this.parser.regexes['plus-signal'], 'plus').
			replace(this.parser.regexes['between-brackets'], ' ').
			normalize('NFD').toLowerCase().replace(this.parser.regexes['accents'], ''). // replace/normalize accents
			split(' ').
			map(s => {
				if(s.charAt(0) == '-'){
					if(allowModifier){
						s = s.replace(this.parser.regexes['non-alpha'], '').replace(this.parser.regexes['hyphen-not-modifier'], '')
						return s.length ? '-' + s : ''
					} else {
						return ''
					}
				}
				return s.replace(this.parser.regexes['non-alpha'], '').replace(this.parser.regexes['hyphen-not-modifier'], '')
			}).
			filter(s => {
				return s && this.stopWords.indexOf(s) == -1
			}))
	}
	match(needleTerms, stackTerms, partial){ // partial=true will match "starts with" terms too
		if(needleTerms.length && stackTerms.length){
			let score = 0, excludeMatch
			needleTerms = needleTerms.filter(t => {
				if(!excludeMatch && t.charAt(0) == '-'){
					if(stackTerms.includes(t.substr(1))){
						excludeMatch = true
					}
					return false
				}
				return true
			})
			if(excludeMatch || !needleTerms.length){
				return 0
			}
			needleTerms.forEach(term => {
				if(partial === true){
					let len = term.length
					stackTerms.filter(t => t.charAt(0) != '-').some(strm => {
						if(len == strm.length){
							if(strm == term){
								score++
								return true
							}
						} else if(strm.length > term.length && term == strm.substr(0, len)){
							score++
							return true
						}
					})
				} else {
					if(stackTerms.filter(t => t.charAt(0) != '-').includes(term)){
						score++
					}
				}
			})
			if(score){
				if(score == needleTerms.length) { // all search terms are present
					if(score == stackTerms.length){ // terms are equal
						return 3
					} else {
						return 2
					}
				} else if(needleTerms.length >= 3 && score == (needleTerms.length - 1)){
					return 1
				}
			}
		}
		return 0
	}
	validateType(e, type, strict){
		if(typeof(type) == 'string' && type){
			switch(type){
				case 'live':
					if(strict){
						return this.msi.isLive(e.url)
					} else {
						let ext = this.msi.ext(e.url)
						return !(this.msi.isVideo(e.url, ext) || this.msi.isAudio(e.url, ext))
					}
					break
				case 'video':
					if(strict){
						return this.msi.isVideo(e.url)
					} else {
						let ext = this.msi.ext(e.url)
						return !(this.msi.isLive(e.url, ext) || this.msi.isAudio(e.url, ext))
					}
					break
				case 'audio':
					if(strict){
						return this.msi.isAudio(e.url)
					} else {
						let ext = this.msi.ext(e.url)
						return this.msi.isAudio(e.url, ext) || !(this.msi.isLive(e.url, ext) || this.msi.isVideo(e.url, ext))
					}
					break
			}
		}
		return true
	}
	prepareEntry(e){
		if(typeof(e.terms) == 'undefined'){
			e.terms = {
				name: this.terms(e.name),
				group: this.terms(e.group || '')
			}
		}
		return e
	}
	prepareEntries(es){		
		return es.map(this.prepareEntry.bind(this))
	}
}

module.exports = Common
