'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class UserSchema extends Schema {
  up () {
    this.create('users', (table) => {
      table.increments()
      table.string('username', 80).notNullable().unique()
      table.text('email').notNullable().unique()
      table.text('password').notNullable()
      table.text('description').nullable()
      table.text('user_image').nullable().defaultTo('https://i.imgur.com/3fnDbHr.jpg')
      table.boolean('public_profile').notNullable().defaultTo(0)
      table.boolean('role').notNullable().defaultTo()
      table.timestamps()
    })
  }

  down () {
    this.drop('users')
  }
}

module.exports = UserSchema
