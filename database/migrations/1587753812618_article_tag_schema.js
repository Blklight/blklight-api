'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class ArticleTagSchema extends Schema {
  up () {
    this.create('article_tags', (table) => {
      table.increments()
      table.integer('tag_id').unsigned().references('id').inTable('tags')
      table.integer('article_id').unsigned().references('id').inTable('articles')
    })
  }

  down () {
    this.drop('article_tags')
  }
}

module.exports = ArticleTagSchema
