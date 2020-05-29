'use strict'

/*
|--------------------------------------------------------------------------
| StatusSeeder
|--------------------------------------------------------------------------
|
| Make use of the Factory instance to seed database with dummy data or
| make use of Lucid models directly.
|
*/

/** @type {import('@adonisjs/lucid/src/Factory')} */
const Factory = use('Factory')
const StatusModel = use('App/Models/Status')

class StatusSeeder {
  async run () {
    await StatusModel.create({
      status: 'Rascunho'
    })

    await StatusModel.create({
      status: 'Publicado'
    })


  }
}

module.exports = StatusSeeder
