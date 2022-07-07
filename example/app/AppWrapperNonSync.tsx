import React from 'react';
import {SafeAreaView, StyleSheet, View} from 'react-native';

import {TaskRealmContext} from './models';
import colors from './styles/colors';
import {AppNonSync} from './AppNonSync';

import Realm, {BSON} from 'realm';

const TaskSchema = {
  name: 'Task',
  properties: {
    _id: 'int',
    name: 'string',
    status: 'string?',
  },
  primaryKey: '_id',
};

const realm = new Realm({
  schema: [TaskSchema],
});

realm.write(() => {
  realm.create('Task', {
    id: new BSON.ObjectId(),
    name: 'asd',
  });
});

export const AppWrapperNonSync = () => {
  // const {RealmProvider} = TaskRealmContext;

  // If sync is disabled, setup the app without any sync functionality and return early
  return (
    <SafeAreaView style={styles.screen}>
      <View />
      {/* <RealmProvider /> */}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.darkBlue,
  },
});
